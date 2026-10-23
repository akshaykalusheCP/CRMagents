import { claudeKey } from '../agent/keys.js';
import { anthropicClient } from '../agent/llm.js';
import { imageBlocks, type ImageInput } from '../agent/images.js';
import { aiClient } from '../agent/provider.js';
import { usageFrom } from '../agent/pricing.js';
import { pool } from '../db.js';
import { getSetting } from '../settings.js';
import { spendGuard } from '../spend.js';
import { logAiCall } from '../trust/aiLog.js';

// Scanned PDFs (pages that are only images) are read by Claude, which sees each page. Uses the low-cost model;
// the cost counts toward the workspace's daily AI budget like any other AI use.

const OCR_MODEL = 'claude-haiku-5-5';
const MAX_PAGES = 100;

export async function ocrPdf(accountId: string, pdf: Buffer, pages: number, title: string): Promise<string> {
  if (pages > MAX_PAGES) throw new Error(`This scanned PDF has ${pages} pages; reading scans works up to ${MAX_PAGES}. Split it into smaller files.`);
  const ck = await claudeKey(accountId);
  if (!ck) throw new Error('Reading scanned PDFs uses Claude: add a Claude key in Settings → AI & spending.');
  await spendGuard(accountId)(0);
  const client = anthropicClient(ck.key, ck.workspaceId ?? undefined);
  // Long transcripts: streamed so the request can't time out.
  const msg = await client.messages.stream({
    model: OCR_MODEL,
    max_tokens: 64000,
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } },
        { type: 'text', text: 'Transcribe all the text in this document exactly, page by page. Start each page with a line "## Page N". Keep headings on their own line and keep lists and tables readable as plain text. Output only the transcript.' },
      ],
    }],
  }).finalMessage();
  const usage = usageFrom(OCR_MODEL, msg.usage);
  void logAiCall(accountId, 'anthropic', { purpose: 'Reading a scanned PDF' }, { model: OCR_MODEL, ms: 0,
    request: { messages: [{ role: 'user', content: [{ document: `PDF "${title}", ${pages} pages (not stored here)` }, { text: 'Transcribe all the text in this document exactly, page by page.' }] }] },
    response: { stop: msg.stop_reason, content: [{ text: `${msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').length} characters of transcript (stored as a guide)` }] },
    usage: { input: usage.input, output: usage.output, costUsd: usage.costUsd } });
  // Logged like a run so it shows in usage and counts toward the daily budget.
  await pool.query(
    `insert into runs (tenant_id, input, status, output, input_tokens, output_tokens, cost_usd)
     select t.id, $2, 'done', $3, $4, $5, $6 from tenants t where t.account_id=$1 order by t.created_at limit 1`,
    [accountId, JSON.stringify({ knowledge: 'ocr', title }), `Read scanned PDF "${title}"`, usage.input, usage.output, usage.costUsd]);
  if (msg.stop_reason === 'max_tokens') throw new Error('This scan has too much text to read in one go. Split it into smaller files.');
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
}

/** What a person needs from an image on a record or in a guide: what it shows, and every word in it. */
export const IMAGE_PROMPT = 'Describe this image for someone who cannot see it, in 2 to 4 sentences: what it shows and anything that looks wrong, damaged or important. Then, under a line "Text in the image:", transcribe every piece of visible text exactly (or write "none"). Do not guess beyond what is visible.';

/** An image read by the workspace's AI (any provider that accepts images; the low-cost model). */
export async function readImage(accountId: string, img: ImageInput, title: string, purpose = 'Reading an image'): Promise<{ text: string; costUsd: number }> {
  await spendGuard(accountId)(0);
  const client = await aiClient(accountId, { purpose });
  const res: any = await client.messages.create({
    model: OCR_MODEL, max_tokens: 4000,
    messages: [{ role: 'user', content: [...imageBlocks([img]), { type: 'text', text: IMAGE_PROMPT }] }],
  } as never);
  const usage = usageFrom(OCR_MODEL, res.usage ?? {});
  await pool.query(
    `insert into runs (tenant_id, input, status, output, input_tokens, output_tokens, cost_usd)
     select t.id, $2, 'done', $3, $4, $5, $6 from tenants t where t.account_id=$1 order by t.created_at limit 1`,
    [accountId, JSON.stringify({ knowledge: 'image', title }), `Read image "${title}"`, usage.input, usage.output, usage.costUsd]);
  const text = (res.content ?? []).map((b: any) => (b.type === 'text' ? b.text : '')).join('').trim();
  if (!text) throw new Error('The AI returned nothing for this image.');
  return { text, costUsd: usage.costUsd };
}
