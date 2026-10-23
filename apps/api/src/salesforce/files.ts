import { extractText } from '../knowledge/store.js';
import { checkImages, imageFromExtension, MAX_IMAGE_BYTES, type ImageInput } from '../agent/images.js';
import type { RecordFile, SalesforceClient } from './client.js';

// Files attached to Salesforce records, as text for the AI (PDF, Word, text, CSV, HTML), and new files written back.

export const READABLE = new Set(['pdf', 'docx', 'txt', 'md', 'csv', 'html', 'htm', 'json', 'xml', 'log', 'eml']);
/** Images the AI can look at (photos of damage, screenshots of errors, scanned forms). */
export const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

/** A record's image file, checked and ready for the AI. */
export async function fileImage(sf: SalesforceClient, f: Pick<RecordFile, 'versionId' | 'title' | 'extension' | 'size'>): Promise<ImageInput> {
  const mediaType = imageFromExtension(f.extension);
  if (!mediaType) throw new Error(`.${f.extension} isn't an image the AI can look at (JPG, PNG, GIF, WebP)`);
  if (f.size > MAX_IMAGE_BYTES) throw new Error(`${f.title} is over 5 MB, too big for the AI to look at`);
  const data = await sf.downloadFile(f.versionId);
  return checkImages([{ mediaType, data: data.toString('base64'), name: `${f.title}.${f.extension}` }])[0];
}

/** Turns an image into text (what it shows + the text in it); provided by the caller, which pays for the AI. */
export type DescribeImage = (img: ImageInput) => Promise<string>;
const MAX_FILE_BYTES = 15 * 1024 * 1024;

export async function fileText(sf: SalesforceClient, f: Pick<RecordFile, 'versionId' | 'title' | 'extension' | 'size'>, maxChars = 20_000): Promise<string> {
  if (!READABLE.has(f.extension)) throw new Error(`Can't read .${f.extension} files (PDF, Word, text, CSV and HTML can be read)`);
  if (f.size > MAX_FILE_BYTES) throw new Error(`${f.title} is over 15 MB`);
  const { text } = await extractText(`${f.title}.${f.extension}`, await sf.downloadFile(f.versionId));
  const t = text.trim();
  return t.length > maxChars ? `${t.slice(0, maxChars)}\n… [cut: the file has ${t.length.toLocaleString()} characters]` : t;
}

/** The text of a record's readable files, newest first, within a total size. */
export async function recordFilesText(sf: SalesforceClient, recordId: string, maxFiles = 5, maxChars = 30_000, describe?: DescribeImage) {
  const files = (await sf.listFiles(recordId)).filter((f) => READABLE.has(f.extension) || (describe && IMAGE_EXT.has(f.extension))).slice(0, maxFiles);
  const parts: string[] = [];
  let left = maxChars;
  for (const f of files) {
    if (left < 500) break;
    const read = IMAGE_EXT.has(f.extension) && describe ? fileImage(sf, f).then(describe) : fileText(sf, f, left);
    const t = await read.catch((e) => `(could not read: ${(e as Error).message})`);
    parts.push(`### ${f.title}.${f.extension}\n${t}`);
    left -= t.length;
  }
  return { text: parts.join('\n\n') || 'No readable files on this record.', files: files.map((f) => ({ title: f.title, extension: f.extension, versionId: f.versionId })) };
}

export function fileNameFor(title: string, format: string) {
  const ext = ['md', 'csv', 'html', 'txt', 'json'].includes(format) ? format : 'txt';
  return `${title.replace(/[^\w .-]+/g, '').trim().slice(0, 80) || 'file'}.${ext}`;
}
