import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Me, type MemoryItem, type RecordNote, type Tenant } from '../api';
import { Empty, PageHeader, Panel, SkeletonRows, toast } from '../components/ui';

// Memory: what assistants and agents carry from one conversation or run to the next. Team definitions everyone's
// assistants use, each person's own preferences, and short notes agents kept on records. All visible, editable
// and deletable; never customers' personal data; can be switched off for the workspace.

const when = (d: string) => new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' });

function MemoryList({ items, canEdit, onChange, empty }: { items: MemoryItem[]; canEdit: boolean; onChange: () => void; empty: string }) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const save = async () => {
    if (!editing) return;
    try { await api.updateMemory(editing.id, editing.text); setEditing(null); onChange(); toast('Memory updated'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  if (!items.length) return <p className="muted small" style={{ margin: 0 }}>{empty}</p>;
  return (
    <ul className="mem-list">
      {items.map((m) => (
        <li key={m.id}>
          {editing?.id === m.id ? (
            <div className="mem-edit">
              <input value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') void save(); if (e.key === 'Escape') setEditing(null); }} autoFocus aria-label="Memory" />
              <button className="primary sm" onClick={() => void save()}>Save</button>
              <button className="sm" onClick={() => setEditing(null)}>Cancel</button>
            </div>
          ) : <>
            <div className="mem-text"><b>{m.text}</b>
              <span>{m.source === 'assistant' ? 'Saved in a chat' : 'Added here'}{m.createdBy ? ` by ${m.createdBy}` : ''} · {when(m.createdAt)}{m.uses ? ` · used ${m.uses} time${m.uses === 1 ? '' : 's'}` : ''}</span>
            </div>
            {canEdit && <div className="row-actions">
              <button className="ghost icon" aria-label="Edit" title="Edit" onClick={() => setEditing({ id: m.id, text: m.text })}><Pencil size={14} /></button>
              <button className="ghost icon" aria-label="Forget" title="Forget" onClick={() => void api.deleteMemory(m.id).then(onChange).then(() => toast('Forgotten')).catch((e) => toast((e as Error).message, 'bad'))}><Trash2 size={14} /></button>
            </div>}
          </>}
        </li>
      ))}
    </ul>
  );
}

function AddMemory({ scope, onAdded, placeholder }: { scope: 'personal' | 'team'; onAdded: () => void; placeholder: string }) {
  const [text, setText] = useState('');
  const add = async () => {
    if (!text.trim()) return;
    try { await api.addMemory(text, scope); setText(''); onAdded(); toast('Remembered'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  return (
    <div className="mem-add">
      <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void add(); }} placeholder={placeholder} aria-label="New memory" maxLength={300} />
      <button className="sm" onClick={() => void add()} disabled={!text.trim()}><Plus size={14} /> Add</button>
    </div>
  );
}

export function MemoryPage({ me, tenants }: { me: Me; tenants: Tenant[] }) {
  const [d, setD] = useState<{ on: boolean; canTeam: boolean; memories: MemoryItem[]; notes: RecordNote[] }>();
  const load = () => api.memories().then(setD).catch((e) => toast((e as Error).message, 'bad'));
  useEffect(() => { void load(); }, []);
  const admin = ['owner', 'admin'].includes(me.role);
  const toggle = async (on: boolean) => {
    try { await api.saveSettings({ memoryEnabled: on ? 'on' : 'off' }); await load(); toast(on ? 'Memory on' : 'Memory off: nothing is remembered or used'); } catch (e) { toast((e as Error).message, 'bad'); }
  };
  const orgUrl = (tenantId: string) => tenants.find((t) => t.id === tenantId)?.sf_instance_url ?? '';
  const team = d?.memories.filter((m) => m.scope === 'team') ?? [];
  const mine = d?.memories.filter((m) => m.scope === 'personal') ?? [];

  return (
    <div className="pg">
      <PageHeader title="Memory" description="What your assistants and agents remember between conversations. Never customers' personal data."
        actions={admin && d ? <label className="row small mem-toggle"><input type="checkbox" checked={d.on} onChange={(e) => void toggle(e.target.checked)} /> {d.on ? 'Memory on' : 'Memory off'}</label> : undefined} />
      {!d ? <Panel><SkeletonRows rows={4} cols={2} /></Panel> : <>
        {!d.on && <div className="banner warn"><div><b>Memory is off</b><span>Assistants don't save or use memories, and agents don't read or write notes on records. Chats are still saved for each person.</span></div></div>}
        <div className="mem-grid">
          <Panel title="Team memory">
            <p className="muted small mem-help">Definitions every assistant and agent in the workspace uses, like "a hot deal is over $100k and closes this quarter". {d.canTeam ? 'Builders and admins keep these.' : 'Builders and admins keep these.'}</p>
            {d.canTeam && <AddMemory scope="team" onAdded={() => void load()} placeholder="e.g. We call Cases &quot;tickets&quot;" />}
            <MemoryList items={team} canEdit={d.canTeam} onChange={() => void load()} empty="Nothing yet. Assistants save team definitions here when a builder or admin tells them one." />
          </Panel>
          <Panel title="Your memory">
            <p className="muted small mem-help">Only your assistants see these: your role, accounts and how you like answers. Say "remember …" in any chat, or add one here.</p>
            <AddMemory scope="personal" onAdded={() => void load()} placeholder="e.g. I own the enterprise accounts in the West" />
            <MemoryList items={mine} canEdit onChange={() => void load()} empty="Nothing yet." />
          </Panel>
        </div>
        <Panel title="Notes on records" flush>
          <p className="muted small mem-help" style={{ padding: '14px 16px 0' }}>Short facts agents keep on a Salesforce record for next time, like "customer prefers email". Agents and assistants read them when they work on that record.</p>
          {!d.notes.length ? <Empty title="No notes yet" body="Agents add them as they work on records." /> : (
            <ul className="mem-list notes">
              {d.notes.map((n) => (
                <li key={n.id}>
                  <div className="mem-text"><b>{n.note}</b>
                    <span>{n.author ?? 'Agent'} · <a href={`${orgUrl(n.tenantId)}/${n.recordId}`} target="_blank" rel="noreferrer">{n.recordId}</a> · {when(n.createdAt)}</span>
                  </div>
                  <div className="row-actions">
                    <button className="ghost icon" aria-label="Delete note" title="Delete note" onClick={() => void api.deleteRecordNote(n.id).then(load).catch((e) => toast((e as Error).message, 'bad'))}><Trash2 size={14} /></button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </>}
    </div>
  );
}
