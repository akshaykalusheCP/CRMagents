import { extractText } from '../knowledge/store.js';
import type { RecordFile, SalesforceClient } from './client.js';

// Files attached to Salesforce records, as text for the AI (PDF, Word, text, CSV, HTML), and new files written back.

export const READABLE = new Set(['pdf', 'docx', 'txt', 'md', 'csv', 'html', 'htm', 'json', 'xml', 'log', 'eml']);
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function fileText(sf: SalesforceClient, f: Pick<RecordFile, 'versionId' | 'title' | 'extension' | 'size'>, maxChars = 20_000): Promise<string> {
  if (!READABLE.has(f.extension)) throw new Error(`Can't read .${f.extension} files (PDF, Word, text, CSV and HTML can be read)`);
  if (f.size > MAX_FILE_BYTES) throw new Error(`${f.title} is over 15 MB`);
  const { text } = await extractText(`${f.title}.${f.extension}`, await sf.downloadFile(f.versionId));
  const t = text.trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}\n… [cut: the file has ${t.length.toLocaleString()} characters]` : t;
}

/** The text of a record's readable files, newest first, within a total size. */
export async function recordFilesText(sf: SalesforceClient, recordId: string, maxFiles = 5, maxChars = 30_000) {
  const files = (await sf.listFiles(recordId)).filter((f) => READABLE.has(f.extension)).slice(0, maxFiles);
  const parts: string[] = [];
  let left = maxChars;
  for (const f of files) {
    if (left < 500) break;
    const t = await fileText(sf, f, left).catch((e) => `(could not read: ${(e as Error).message})`);
    parts.push(`### ${f.title}.${f.extension}\n${t}`);
    left -= t.length;
  }
  return { text: parts.join('\n\n') || 'No readable files on this record.', files: files.map((f) => ({ title: f.title, extension: f.extension, versionId: f.versionId })) };
}

export function fileNameFor(title: string, format: string) {
  const ext = ['md', 'csv', 'html', 'txt', 'json'].includes(format) ? format : 'txt';
  return `${title.replace(/[^\w .-]+/g, '').trim().slice(0, 80) || 'file'}.${ext}`;
}
