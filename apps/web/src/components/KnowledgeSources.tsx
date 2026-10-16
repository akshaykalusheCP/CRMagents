import { BookOpen, FolderOpen, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type KnowledgeSource, type Tenant } from '../api';
import { Panel, toast } from './ui';

// Knowledge that already lives in Salesforce: published Knowledge articles and Files libraries. Synced now and
// then once a day, so edits and removals in Salesforce carry over.

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(iso).toLocaleDateString();
};

export function KnowledgeSources({ tenant, onSynced }: { tenant?: Tenant; onSynced: () => void }) {
  const [list, setList] = useState<KnowledgeSource[]>([]);
  const [library, setLibrary] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api.knowledgeSources().then(setList).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!tenant) return null;

  const run = async (key: string, fn: () => Promise<{ result: string; ok: boolean }>) => {
    setBusy(key);
    try { const r = await fn(); toast(r.result, r.ok ? 'ok' : 'bad'); onSynced(); void load(); }
    catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(''); }
  };
  const hasArticles = list.some((s) => s.kind === 'articles' && s.tenantId === tenant.id);

  return (
    <Panel title="From Salesforce" action={<span className="kb-meta">Synced daily</span>}>
      <div className="kb-sources">
        {list.map((s) => (
          <div key={s.id} className="kb-source">
            {s.kind === 'articles' ? <BookOpen size={16} /> : <FolderOpen size={16} />}
            <div className="cell-main" style={{ flex: 1, minWidth: 0 }}>
              <b>{s.kind === 'articles' ? 'Knowledge articles' : `Files library: ${s.library}`}</b>
              <span className="cell-sub">{s.org} · {ago(s.lastSyncedAt)}{s.lastResult ? ` · ${s.lastResult}` : ''}</span>
            </div>
            <button className="sm" onClick={() => void run(s.id, () => api.syncKnowledgeSource(s.id))} disabled={!!busy}>{busy === s.id ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />} Sync now</button>
            <button className="ghost icon sm" aria-label="Remove source" onClick={async () => { await api.removeKnowledgeSource(s.id); onSynced(); void load(); }}><Trash2 size={14} /></button>
          </div>
        ))}
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          {!hasArticles && (
            <button onClick={() => void run('articles', () => api.addKnowledgeSource({ tenantId: tenant.id, kind: 'articles' }))} disabled={!!busy}>
              {busy === 'articles' ? <Loader2 size={14} className="spin" /> : <BookOpen size={14} />} Add Knowledge articles
            </button>
          )}
          <input value={library} onChange={(e) => setLibrary(e.target.value)} placeholder="Files library name, e.g. Support Guides" style={{ width: 260 }} aria-label="Files library name" />
          <button onClick={() => void run('library', () => api.addKnowledgeSource({ tenantId: tenant.id, kind: 'library', library })).then(() => setLibrary(''))} disabled={!!busy || !library.trim()}>
            {busy === 'library' ? <Loader2 size={14} className="spin" /> : <FolderOpen size={14} />} Add library
          </button>
        </div>
        <p className="muted small" style={{ margin: 0 }}>From {tenant.sf_username ?? 'this org'}. Published articles only; library files can be PDF (scans included), Word, text or HTML.</p>
      </div>
    </Panel>
  );
}
