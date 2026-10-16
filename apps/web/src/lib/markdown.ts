// Markdown -> a small, safe subset of HTML (bold, italic, code, headings, lists, tables, links, paragraphs).
// Everything is HTML-escaped first and only fixed tags are produced, so model output can't inject markup.
// Kept dependency-free; the same code is used by the CRMagents web app.

const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(s: string): string {
    let t = esc(s);
    t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/__([^_]+)__/g, '<b>$1</b>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<i>$2</i>').replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<i>$2</i>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
}

const isRow = (l: string) => /^\s*\|.*\|\s*$/.test(l);
const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

export function markdownToHtml(md: unknown): string {
    const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
    const out: string[] = [];
    let list: 'ul' | 'ol' | null = null;
    let para: string[] = [];
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const h = /^\s*(#{1,6})\s+(.*)$/.exec(line);
        const ul = /^\s*[-*•]\s+(.*)$/.exec(line);
        const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (!line.trim()) { flushPara(); closeList(); continue; }
        if (isRow(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
            flushPara(); closeList();
            const head = cells(line);
            const rows: string[][] = [];
            i += 2;
            while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
            i--;
            out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
            continue;
        }
        if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flushPara(); closeList(); out.push('<hr>'); continue; }
        if (h) { flushPara(); closeList(); out.push(`<p><b>${inline(h[2])}</b></p>`); continue; }
        if (ul || ol) {
            flushPara();
            const kind = ul ? 'ul' : 'ol';
            if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
            out.push(`<li>${inline((ul || ol)![1])}</li>`);
            continue;
        }
        closeList();
        para.push(line.trim());
    }
    flushPara(); closeList();
    return out.join('');
}
