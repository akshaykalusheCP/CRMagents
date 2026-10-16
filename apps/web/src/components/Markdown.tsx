import { markdownToHtml } from '../lib/markdown';

/** AI answers formatted (bold, lists, tables, links). The converter escapes all HTML and emits a fixed tag set. */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return <div className={`md ${className}`} dangerouslySetInnerHTML={{ __html: markdownToHtml(text) }} />;
}
