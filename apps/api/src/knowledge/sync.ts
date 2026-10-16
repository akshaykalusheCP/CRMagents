import { pool } from '../db.js';
import { SalesforceClient } from '../salesforce/client.js';
import { allowed, apiLevel } from '../salesforce/limits.js';
import { READABLE } from '../salesforce/files.js';
import { addDocument, extractText, looksScanned } from './store.js';
import { ocrPdf } from './ocr.js';

// Knowledge that already lives in Salesforce: published Knowledge articles and the files of a Files library.
// Synced into the knowledge base on request and then once a day, so assistants and agents search them like
// uploaded guides. Each sync replaces that source's documents, so edits and removals in Salesforce carry over.

const MAX_ARTICLES = 5000;
const MAX_LIBRARY_FILES = 200;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export const stripHtml = (h: string) => h
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  .replace(/<\s*(br|\/p|\/li|\/h\d|\/div|\/tr)\s*\/?>/gi, '\n')
  .replace(/<li[^>]*>/gi, '- ')
  .replace(/<h(\d)[^>]*>/gi, (_m, n: string) => '\n' + '#'.repeat(Math.min(Number(n), 6)) + ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();

async function replaceSource(accountId: string, source: string, refPrefix: string) {
  await pool.query('delete from knowledge_docs where account_id=$1 and source=$2 and source_ref like $3', [accountId, source, `${refPrefix}%`]);
}

/** Published Knowledge articles (latest versions) with their text fields. */
export async function syncArticles(accountId: string, tenantId: string): Promise<string> {
  const sf = await SalesforceClient.forTenant(tenantId);
  const kav = (await sf.describeGlobal()).find((o) => /__kav$/i.test(o.name) && o.queryable);
  if (!kav) throw new Error('Salesforce Knowledge is not turned on in this org.');
  const fields = await sf.describe(kav.name);
  const body = fields.filter((f) => ['textarea', 'html'].includes(f.type) && f.name !== 'Summary').map((f) => f.name).slice(0, 20);
  const r = await sf.queryAll(
    `SELECT Id, KnowledgeArticleId, Title, Summary, UrlName${body.length ? `, ${body.join(', ')}` : ''} FROM ${kav.name} WHERE PublishStatus = 'Online' AND IsLatestVersion = true`,
    MAX_ARTICLES);
  const ref = `${tenantId}:`;
  await replaceSource(accountId, 'sf_article', ref);
  let added = 0;
  for (const a of r.records as Record<string, unknown>[]) {
    const parts = [a.Summary, ...body.map((f) => a[f])].filter((x) => typeof x === 'string' && x.trim()).map((x) => stripHtml(String(x)));
    if (!parts.length) continue;
    await addDocument(accountId, {
      title: String(a.Title ?? 'Article'), fileName: String(a.UrlName ?? ''), kind: 'text', text: parts.join('\n\n'),
      source: 'sf_article', sourceRef: `${ref}${a.KnowledgeArticleId ?? a.Id}`, tenantId, createdBy: 'Salesforce Knowledge',
    }).then(() => added++).catch(() => undefined);
  }
  return `${added} article${added === 1 ? '' : 's'} synced`;
}

/** Every readable file in a Salesforce Files library (PDF, Word, text, CSV, HTML; scans are read by Claude). */
export async function syncLibrary(accountId: string, tenantId: string, library: string): Promise<string> {
  const sf = await SalesforceClient.forTenant(tenantId);
  const ws = await sf.query(`SELECT Id, Name FROM ContentWorkspace WHERE Name = '${library.replace(/'/g, "\\'")}' LIMIT 1`);
  const lib = ws.records[0] as { Id: string; Name: string } | undefined;
  if (!lib) throw new Error(`No Files library named "${library}" (check Files → Libraries in Salesforce).`);
  const docs = await sf.queryAll(
    `SELECT ContentDocumentId, ContentDocument.Title, ContentDocument.FileExtension, ContentDocument.ContentSize, ContentDocument.LatestPublishedVersionId FROM ContentWorkspaceDoc WHERE ContentWorkspaceId = '${lib.Id}'`,
    MAX_LIBRARY_FILES);
  const ref = `${tenantId}:${lib.Id}:`;
  await replaceSource(accountId, 'sf_library', ref);
  let added = 0;
  const skipped: string[] = [];
  for (const d of docs.records as any[]) {
    const ext = String(d.ContentDocument?.FileExtension ?? '').toLowerCase();
    const title = String(d.ContentDocument?.Title ?? 'File');
    if (!READABLE.has(ext) || Number(d.ContentDocument?.ContentSize ?? 0) > MAX_FILE_BYTES) { skipped.push(title); continue; }
    try {
      const data = await sf.downloadFile(d.ContentDocument.LatestPublishedVersionId);
      let { kind, text, pages } = await extractText(`${title}.${ext}`, data);
      if (kind === 'pdf' && looksScanned(text)) text = await ocrPdf(accountId, data, pages ?? 1, title);
      await addDocument(accountId, { title, fileName: `${title}.${ext}`, kind, text, source: 'sf_library', sourceRef: `${ref}${d.ContentDocumentId}`, tenantId, createdBy: `Library: ${lib.Name}` });
      added++;
    } catch {
      skipped.push(title);
    }
  }
  return `${added} file${added === 1 ? '' : 's'} synced${skipped.length ? `; skipped ${skipped.length} (${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? '…' : ''})` : ''}`;
}

export async function addSource(accountId: string, tenantId: string, kind: 'articles' | 'library', library?: string) {
  const { rows } = await pool.query(
    `insert into knowledge_sources (account_id, tenant_id, kind, library) values ($1,$2,$3,$4)
     on conflict (tenant_id, kind, library) do update set account_id=excluded.account_id returning id`,
    [accountId, tenantId, kind, kind === 'library' ? library ?? '' : '']);
  return syncSource(rows[0].id);
}

export async function syncSource(id: string): Promise<{ id: string; result: string; ok: boolean }> {
  const { rows } = await pool.query('select * from knowledge_sources where id=$1', [id]);
  const s = rows[0];
  if (!s) throw Object.assign(new Error('source not found'), { statusCode: 404 });
  let result: string;
  let ok = true;
  try {
    result = s.kind === 'articles' ? await syncArticles(s.account_id, s.tenant_id) : await syncLibrary(s.account_id, s.tenant_id, s.library);
  } catch (e) {
    ok = false;
    result = (e as Error).message;
  }
  await pool.query('update knowledge_sources set last_synced_at=now(), last_result=$2 where id=$1', [id, result.slice(0, 500)]);
  return { id, result, ok };
}

export async function listSources(accountId: string) {
  const { rows } = await pool.query(
    `select s.id, s.kind, s.library, s.last_synced_at as "lastSyncedAt", s.last_result as "lastResult", t.sf_username as "org", s.tenant_id as "tenantId"
     from knowledge_sources s join tenants t on t.id = s.tenant_id where s.account_id=$1 order by s.created_at`, [accountId]);
  return rows;
}

export async function removeSource(accountId: string, id: string) {
  const { rows } = await pool.query('delete from knowledge_sources where id=$1 and account_id=$2 returning tenant_id, kind, library', [id, accountId]);
  const s = rows[0];
  if (!s) return;
  if (s.kind === 'articles') await replaceSource(accountId, 'sf_article', `${s.tenant_id}:`);
  else await pool.query("delete from knowledge_docs where account_id=$1 and tenant_id=$2 and source='sf_library' and created_by=$3", [accountId, s.tenant_id, `Library: ${s.library}`]);
}

/** Daily refresh of every source (optional work: skipped while an org's API allowance is running low). */
export async function syncDue() {
  const { rows } = await pool.query("select id, tenant_id from knowledge_sources where last_synced_at is null or last_synced_at < now() - interval '1 day'");
  for (const r of rows) {
    if (!allowed(apiLevel(r.tenant_id), 'background')) continue;
    await syncSource(r.id).catch(() => undefined);
  }
}

