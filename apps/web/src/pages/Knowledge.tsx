import { FileText, Loader2, Search, ThumbsDown, ThumbsUp, Trash2, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, type KnowledgeDoc, type KnowledgeHit, type RecordSuggestion, type Tenant } from '../api';
import { Markdown } from '../components/Markdown';
import { KnowledgeSources } from '../components/KnowledgeSources';
import { Empty, PageHeader, Panel, SkeletonRows, Status, Table, toast, useConfirm, type Column } from '../components/ui';

// Knowledge: the company's own guides. Assistants search them automatically; agents use them to write
// suggestions that show up on the record in Salesforce.

const ACCEPT = '.pdf,.docx,.md,.txt,.html,.htm,.csv';
const MAX_MB = 15;
const CASE_AGENT = 'When a new Case is created, look up our support guides using the case subject and description, write short troubleshooting steps for the support agent, and show them as a suggestion on the case.';

const KIND: Record<KnowledgeDoc['kind'], string> = { pdf: 'PDF', docx: 'Word', text: 'Text' };
const ago = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(iso).toLocaleDateString();
};

function toBase64(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(new Error(`Could not read ${f.name}`));
    r.readAsDataURL(f);
  });
}

export function KnowledgePage({ tenant, onAutomate }: { tenant?: Tenant; onAutomate: (request: string) => void }) {
  const [docs, setDocs] = useState<KnowledgeDoc[] | null>(null);
  const [uploading, setUploading] = useState<string[]>([]);
  const [drag, setDrag] = useState(false);
  const [paste, setPaste] = useState(false);
  const [pTitle, setPTitle] = useState('');
  const [pText, setPText] = useState('');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [sugs, setSugs] = useState<RecordSuggestion[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [confirmUi, ask] = useConfirm();

  const load = () => api.knowledge().then(setDocs).catch((e) => { setDocs([]); toast(e.message, 'bad'); });
  useEffect(() => { void load(); }, []);
  useEffect(() => { if (tenant) api.recordSuggestions(tenant.id).then(setSugs).catch(() => setSugs([])); }, [tenant?.id]);

  const upload = async (files: FileList | File[]) => {
    const list = [...files];
    for (const f of list) {
      if (f.size > MAX_MB * 1024 * 1024) { toast(`${f.name} is over ${MAX_MB} MB`, 'bad'); continue; }
      setUploading((u) => [...u, f.name]);
      try {
        const r = await api.addKnowledge({ fileName: f.name, data: await toBase64(f) });
        toast(`${f.name}: ${r.chunks} section${r.chunks === 1 ? '' : 's'} ready`);
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, 'bad');
      } finally {
        setUploading((u) => u.filter((n) => n !== f.name));
      }
    }
    void load();
  };

  const savePaste = async () => {
    if (!pText.trim()) return;
    setUploading((u) => [...u, pTitle || 'Pasted text']);
    try {
      await api.addKnowledge({ title: pTitle.trim() || 'Pasted text', text: pText });
      setPaste(false); setPTitle(''); setPText('');
      toast('Added to knowledge');
      void load();
    } catch (e) { toast((e as Error).message, 'bad'); }
    finally { setUploading([]); }
  };

  const remove = async (d: KnowledgeDoc) => {
    if (!(await ask({ title: `Remove "${d.title}"?`, body: 'Assistants and agents stop using it right away.', confirm: 'Remove', danger: true }))) return;
    await api.deleteKnowledge(d.id);
    setDocs((x) => x?.filter((y) => y.id !== d.id) ?? null);
    setHits(null);
  };

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!q.trim()) return;
    setSearching(true);
    try { setHits(await api.searchKnowledge(q.trim())); }
    catch (err) { toast((err as Error).message, 'bad'); }
    finally { setSearching(false); }
  };

  const mark = async (s: RecordSuggestion, status: RecordSuggestion['status']) => {
    if (!tenant) return;
    await api.markSuggestion(tenant.id, s.id, status);
    setSugs((x) => x.map((y) => (y.id === s.id ? { ...y, status } : y)));
  };

  const cols: Column<KnowledgeDoc>[] = [
    { key: 'title', header: 'Document', render: (d) => <div className="cell-main"><b><FileText size={14} className="kb-ico" />{d.title}</b><span className="cell-sub">{d.fileName ?? 'Pasted text'}</span></div> },
    { key: 'kind', header: 'Type', hideSm: true, render: (d) => (d.source === 'sf_article' ? 'Knowledge article' : d.source === 'sf_library' ? `${KIND[d.kind]} · Salesforce Files` : KIND[d.kind]) },
    { key: 'chunks', header: 'Sections', align: 'right', render: (d) => d.chunks.toLocaleString() },
    { key: 'by', header: 'Added', hideSm: true, render: (d) => <div className="cell-main"><span>{ago(d.createdAt)}</span><span className="cell-sub">{d.createdBy ?? ''}</span></div> },
    { key: 'x', header: '', align: 'right', render: (d) => <button className="ghost icon sm" onClick={() => void remove(d)} aria-label={`Remove ${d.title}`}><Trash2 size={14} /></button> },
  ];

  const sugCols: Column<RecordSuggestion>[] = [
    { key: 't', header: 'Suggestion', render: (s) => <div className="cell-main"><b>{s.title || 'Suggestion'}{s.kind === 'email_reply' && s.meta?.to ? <span className="cell-sub"> · reply to {s.meta.to}</span> : null}</b><span className="cell-sub kb-snip">{s.body.replace(/[*#>`_]/g, '').slice(0, 140)}</span></div> },
    { key: 'r', header: 'Record', hideSm: true, render: (s) => tenant ? <a href={`${tenant.sf_instance_url}/${s.recordId}`} target="_blank" rel="noreferrer" className="kb-rec">{s.objectName || 'Record'} {s.recordId.slice(-6)}</a> : s.recordId },
    { key: 'a', header: 'Agent', hideSm: true, render: (s) => s.agentName ?? '—' },
    { key: 's', header: 'Feedback', render: (s) => s.status === 'sent' ? <Status tone="ok">Sent by email</Status> : s.status === 'helpful' ? <Status tone="ok">Helpful</Status> : s.status === 'not_helpful' ? <Status tone="bad">Not helpful</Status> : s.status === 'dismissed' ? <Status tone="neutral">Dismissed</Status> : <Status tone="info">New</Status> },
    { key: 'w', header: '', hideSm: true, render: (s) => <span className="cell-sub">{ago(s.createdAt)}</span> },
  ];

  const rated = sugs.filter((s) => s.status === 'helpful' || s.status === 'not_helpful');
  const helpful = rated.filter((s) => s.status === 'helpful').length;
  const busy = uploading.length > 0;

  return (
    <div className="pg">
      {confirmUi}
      <PageHeader
        title="Knowledge"
        description="Your own guides and policies. Assistants look things up here before answering, and agents use them to suggest fixes on records."
        actions={<button className="primary" onClick={() => onAutomate(CASE_AGENT)}>Build a case-suggestion agent</button>}
      />

      <div
        className={'kb-drop' + (drag ? ' on' : '')}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); if (e.dataTransfer.files.length) void upload(e.dataTransfer.files); }}
      >
        <Upload size={20} />
        <div>
          <b>{busy ? `Reading ${uploading[0]}${uploading.length > 1 ? ` and ${uploading.length - 1} more` : ''}…` : 'Drop support guides here'}</b>
          <span>PDF (scans too), Word, Markdown or text · up to {MAX_MB} MB each</span>
        </div>
        <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
          <button className="ghost" onClick={() => setPaste((p) => !p)} disabled={busy}>Paste text</button>
          <button className="primary" onClick={() => fileRef.current?.click()} disabled={busy}>{busy ? <Loader2 size={14} className="spin" /> : 'Choose files'}</button>
        </div>
        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
      </div>

      {paste && (
        <Panel title="Paste text" action={<button className="ghost icon sm" onClick={() => setPaste(false)} aria-label="Close"><X size={14} /></button>}>
          <div className="kb-paste">
            <input value={pTitle} onChange={(e) => setPTitle(e.target.value)} placeholder="Title, e.g. Refund policy" />
            <textarea value={pText} onChange={(e) => setPText(e.target.value)} rows={8} placeholder="Paste the guide here. Headings on their own line help split it into sections." />
            <div className="row" style={{ justifyContent: 'flex-end' }}><button className="primary" onClick={() => void savePaste()} disabled={!pText.trim() || busy}>Add</button></div>
          </div>
        </Panel>
      )}

      <KnowledgeSources tenant={tenant} onSynced={() => void load()} />

      <Panel flush title="Documents" action={docs?.length ? <span className="kb-meta">{docs.length} document{docs.length === 1 ? '' : 's'} · {docs.reduce((n, d) => n + d.chunks, 0).toLocaleString()} sections</span> : undefined}>
        {docs === null ? <SkeletonRows rows={3} cols={4} /> : (
          <Table columns={cols} rows={docs} rowKey={(d) => d.id}
            empty={<Empty title="No documents yet" body="Upload the guides your team already uses: troubleshooting steps, product manuals, policies. Answers will then follow them and say which guide they used." />} />
        )}
      </Panel>

      {!!docs?.length && (
        <Panel title="Try it" action={<span className="kb-meta">The sections an assistant would read for this question</span>}>
          <form className="agent-start" onSubmit={search}>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="e.g. customer cannot connect to wifi" aria-label="Search knowledge" />
            <button type="submit" className="primary" disabled={!q.trim() || searching}>{searching ? <Loader2 size={14} className="spin" /> : <><Search size={14} /> Search</>}</button>
          </form>
          {hits && (hits.length ? (
            <ol className="kb-hits">
              {hits.map((h, i) => (
                <li key={i}>
                  <div className="kb-hit-head"><span className="kb-n">{i + 1}</span><b>{h.title}</b>{h.heading && <span className="cell-sub">{h.heading}</span>}</div>
                  <p>{h.body.length > 420 ? `${h.body.slice(0, 420)}…` : h.body}</p>
                </li>
              ))}
            </ol>
          ) : <p className="cell-sub" style={{ marginTop: 12 }}>Nothing matches. Try the words a customer would use, or upload a guide that covers it.</p>)}
        </Panel>
      )}

      {tenant && (
        <Panel flush title="Suggestions on records"
          action={rated.length ? <span className="kb-meta">{Math.round((helpful / rated.length) * 100)}% rated helpful ({rated.length} rated)</span> : undefined}>
          <Table columns={sugCols} rows={sugs} rowKey={(s) => s.id}
            empty={<Empty title="No suggestions yet" body={<>Agents with a <b>Show suggestion on record</b> step leave advice here and on the record page in Salesforce (CRMagents Suggestions card).</>}
              action={<button className="ghost" onClick={() => onAutomate(CASE_AGENT)}>Build a case-suggestion agent</button>} />} />
          {sugs.length > 0 && <SuggestionPreview s={sugs[0]} onMark={mark} />}
        </Panel>
      )}
    </div>
  );
}

function SuggestionPreview({ s, onMark }: { s: RecordSuggestion; onMark: (s: RecordSuggestion, status: RecordSuggestion['status']) => void }) {
  return (
    <div className="kb-preview">
      <div className="kb-hit-head"><b>Latest: {s.title || 'Suggestion'}</b><span className="cell-sub">{s.agentName ?? ''}</span>
        <span className="row" style={{ marginLeft: 'auto', gap: 4 }}>
          <button className="ghost icon sm" title="Helpful" aria-label="Helpful" onClick={() => onMark(s, 'helpful')}><ThumbsUp size={14} /></button>
          <button className="ghost icon sm" title="Not helpful" aria-label="Not helpful" onClick={() => onMark(s, 'not_helpful')}><ThumbsDown size={14} /></button>
        </span>
      </div>
      <Markdown text={s.body} />
      {s.sources.length > 0 && <div className="cell-sub">Sources: {s.sources.map((x) => x.title + (x.section ? ` (${x.section})` : '')).join('; ')}</div>}
    </div>
  );
}
