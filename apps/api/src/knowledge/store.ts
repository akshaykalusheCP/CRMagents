import { pool } from '../db.js';

// The knowledge base: a company's own documents, split into short sections and searched with Postgres
// full-text search. No embeddings: nothing extra to host, nothing to pay per upload, and answers can cite
// the exact document and section they came from.

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const MAX_CHARS = 2_000_000; // per document, after extraction
const CHUNK_CHARS = 1400;
const MAX_QUERY_WORDS = 60;

export type DocKind = 'pdf' | 'docx' | 'text' | 'image';

export interface Hit { docId: string; title: string; heading: string; body: string; rank: number }

/** Plain text out of an uploaded file. PDFs keep a "Page N" marker so sections can say where they came from. */
export async function extractText(fileName: string, data: Buffer): Promise<{ kind: DocKind; text: string; pages?: number }> {
  const ext = fileName.toLowerCase().split('.').pop() ?? '';
  if (ext === 'pdf' || data.subarray(0, 5).toString() === '%PDF-') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text, totalPages } = await pdfText(pdf, { mergePages: false });
    return { kind: 'pdf', pages: totalPages, text: text.map((t, i) => `## Page ${i + 1}\n\n${tidyPdf(t)}`).join('\n\n') };
  }
  if (ext === 'docx') {
    const mammoth = await import('mammoth');
    const { value } = await mammoth.extractRawText({ buffer: data });
    return { kind: 'docx', text: value };
  }
  if (ext === 'doc' || ext === 'pptx' || ext === 'xlsx') throw new Error('Upload PDF, Word (.docx), Markdown or text files.');
  let text = data.toString('utf8');
  if (/�/.test(text.slice(0, 2000))) throw new Error('This file is not text. Upload PDF, Word (.docx), Markdown or text files.');
  if (ext === 'html' || ext === 'htm') text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ');
  return { kind: 'text', text };
}

/** PDF text comes out as lines; put paragraphs back together so sections don't break mid-sentence. */
function tidyPdf(t: string): string {
  return t.replace(/[ \t]+\n/g, '\n').replace(/([^\n.:;!?])\n(?=[a-z(])/g, '$1 ').trim();
}

const isHeading = (line: string) => {
  const l = line.trim();
  if (/^#{1,6}\s+\S/.test(l)) return true;
  // Short line, no closing punctuation, starts with a capital or a number ("3. Network checks").
  return l.length > 2 && l.length < 70 && !/[.,;:!?)]$/.test(l) && /^([A-Z0-9])/.test(l) && l.split(/\s+/).length <= 9;
};

/** Sections of at most ~CHUNK_CHARS, each tagged with the heading it sits under. */
export function chunkText(text: string): { heading: string; body: string }[] {
  const blocks = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  const out: { heading: string; body: string }[] = [];
  let heading = '';
  let page = '';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n\n').trim();
    if (body) out.push({ heading: [page, heading].filter(Boolean).join(' · '), body });
    buf = [];
  };
  for (const block of blocks) {
    const first = block.split('\n')[0];
    const pageMark = /^## Page (\d+)$/.exec(first);
    if (pageMark) { flush(); page = `Page ${pageMark[1]}`; continue; }
    if (isHeading(first) && block.split('\n').length === 1) {
      flush();
      heading = first.replace(/^#+\s*/, '').trim();
      continue;
    }
    // Very long paragraphs are cut at sentence ends.
    const parts = block.length > CHUNK_CHARS ? block.match(new RegExp(`[\\s\\S]{1,${CHUNK_CHARS}}(?:[.!?](?=\\s)|$)|[\\s\\S]{1,${CHUNK_CHARS}}`, 'g')) ?? [block] : [block];
    for (const p of parts) {
      if (buf.join('\n\n').length + p.length > CHUNK_CHARS) flush();
      buf.push(p.trim());
    }
  }
  flush();
  return out;
}

export async function addDocument(accountId: string, d: { title: string; fileName?: string; kind: DocKind; text: string; createdBy?: string; source?: string; sourceRef?: string; sourceVersion?: string; tenantId?: string }) {
  const text = d.text.slice(0, MAX_CHARS);
  const chunks = chunkText(text);
  if (!chunks.length) throw new Error('No readable text found in this file.');
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query(
      'insert into knowledge_docs (account_id, title, file_name, kind, chars, chunks, created_by, source, source_ref, tenant_id, source_version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id',
      [accountId, d.title.slice(0, 200), d.fileName ?? null, d.kind, text.length, chunks.length, d.createdBy ?? null, d.source ?? 'upload', d.sourceRef ?? null, d.tenantId ?? null, d.sourceVersion ?? null],
    );
    const id = rows[0].id as string;
    // One insert per 200 sections keeps big guides fast.
    for (let i = 0; i < chunks.length; i += 200) {
      const part = chunks.slice(i, i + 200);
      const vals: unknown[] = [];
      const ph = part.map((c, j) => {
        vals.push(id, accountId, i + j, c.heading.slice(0, 300), c.body);
        const b = j * 5;
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5})`;
      });
      await client.query(`insert into knowledge_chunks (doc_id, account_id, seq, heading, body) values ${ph.join(',')}`, vals);
    }
    await client.query('commit');
    return { id, chunks: chunks.length, chars: text.length };
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
}

export async function listDocuments(accountId: string) {
  const { rows } = await pool.query(
    `select id, title, file_name as "fileName", kind, chars, chunks, created_by as "createdBy", created_at as "createdAt", source
     from knowledge_docs where account_id=$1 order by source = 'upload' desc, created_at desc`, [accountId]);
  return rows;
}

export async function deleteDocument(accountId: string, id: string) {
  await pool.query('delete from knowledge_docs where id=$2 and account_id=$1', [accountId, id]);
}

export async function hasKnowledge(accountId: string): Promise<boolean> {
  const { rowCount } = await pool.query('select 1 from knowledge_docs where account_id=$1 limit 1', [accountId]);
  return !!rowCount;
}

/**
 * Best-matching sections for a question or a record's text. Any word can match (OR), sections matching more
 * of the words rank higher. `docs` limits the search to some documents (by id or title).
 */
export async function searchKnowledge(accountId: string, query: string, limit = 4, docs: string[] = []): Promise<Hit[]> {
  const q = query.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').split(/\s+/).filter(Boolean).slice(0, MAX_QUERY_WORDS).join(' ');
  if (!q) return [];
  const { rows } = await pool.query(
    `with q as (select nullif(replace(plainto_tsquery('english', $2)::text, '&', '|'), '')::tsquery as tq)
     select d.id as "docId", d.title, c.heading, c.body, ts_rank_cd(c.tsv, q.tq, 1)::float as rank
     from knowledge_chunks c join knowledge_docs d on d.id = c.doc_id, q
     where c.account_id = $1 and q.tq is not null and c.tsv @@ q.tq
       and (cardinality($4::text[]) = 0 or d.id::text = any($4) or lower(d.title) = any($4))
     order by rank desc limit $3`,
    [accountId, q, Math.min(Math.max(limit, 1), 10) * 3, docs.map((d) => d.toLowerCase())],
  );
  return capPerDoc(rows, Math.min(Math.max(limit, 1), 10));
}

/** Best hits first, but at most `perDoc` from one document, so an answer can draw on several guides. Pure; tested. */
export function capPerDoc<T extends { docId: string }>(hits: T[], limit: number, perDoc = 3): T[] {
  const n = new Map<string, number>();
  const out: T[] = [];
  for (const h of hits) {
    const c = n.get(h.docId) ?? 0;
    if (c >= perDoc) continue;
    n.set(h.docId, c + 1);
    out.push(h);
    if (out.length >= limit) break;
  }
  return out;
}

/** Adds a searchable "Summary" section (what the document covers, and the other words people use for it). */
export async function addSummarySection(docId: string, accountId: string, body: string): Promise<void> {
  await pool.query("delete from knowledge_chunks where doc_id=$1 and seq = -1", [docId]);
  await pool.query("insert into knowledge_chunks (doc_id, account_id, seq, heading, body) values ($1,$2,-1,'Summary',$3)", [docId, accountId, body]);
}

/** Search results as the AI sees them: numbered so the answer can cite [1], [2]. */
export function hitsToText(hits: Hit[]): string {
  if (!hits.length) return 'No matching sections in the knowledge base.';
  return hits.map((h, i) => `[${i + 1}] ${h.title}${h.heading ? ` — ${h.heading}` : ''}\n${h.body}`).join('\n\n---\n\n');
}

/** Where an answer came from, for showing under it. */
export function hitSources(hits: Hit[]): { title: string; section: string }[] {
  const seen = new Set<string>();
  return hits.flatMap((h) => {
    const k = `${h.title}|${h.heading}`;
    if (seen.has(k)) return [];
    seen.add(k);
    return [{ title: h.title, section: h.heading }];
  });
}

/** A PDF with almost no text per page is a scan (images of pages). Pure; tested. */
export function looksScanned(text: string): boolean {
  const pages = text.split(/^## Page \d+$/m).slice(1);
  if (!pages.length) return text.trim().length < 50;
  const chars = pages.reduce((n, p) => n + p.replace(/\s+/g, '').length, 0);
  return chars / pages.length < 40;
}
