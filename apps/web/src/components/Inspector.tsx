import { Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { NODE_DEF_BY_TYPE } from '@crmagents/shared';
import type { Step, ToolInfo } from '../api';
import { NodeTile } from './nodeIcons';
import type { WFRFNode } from './WorkflowNode';

interface Props {
  node: WFRFNode;
  tools: ToolInfo[];
  /** Reference tokens available to this node, e.g. {{sf_get_1.record}} */
  refs: { id: string; label: string; keys: string[] }[];
  inLoop: boolean;
  /** Steps for this node from the latest test run. */
  steps: Step[];
  onChange: (patch: { label?: string; config?: Record<string, any> }) => void;
  onDelete: () => void;
}

export function Inspector({ node, tools, refs, inLoop, steps, onChange, onDelete }: Props) {
  const def = NODE_DEF_BY_TYPE[node.data.type];
  const [tab, setTab] = useState<'settings' | 'run'>('settings');
  const focus = useRef<{ key: string; el: HTMLInputElement | HTMLTextAreaElement } | null>(null);
  if (!def) return null;
  const cfg = node.data.config;
  const set = (key: string, v: unknown) => onChange({ config: { ...cfg, [key]: v } });

  const insert = (token: string) => {
    const f = focus.current;
    if (!f) { navigator.clipboard?.writeText(token); return; }
    const cur = String(cfg[f.key] ?? '');
    const a = f.el.selectionStart ?? cur.length;
    const b = f.el.selectionEnd ?? cur.length;
    set(f.key, cur.slice(0, a) + token + cur.slice(b));
  };

  const chip = (token: string) => (
    <button key={token} className="chip" onMouseDown={(e) => e.preventDefault()} onClick={() => insert(token)} title="Insert into the focused field">{token}</button>
  );

  return (
    <>
      <div className="insp-head">
        <NodeTile type={node.data.type} size="lg" />
        <div className="grow">
          <b>{node.data.label || def.label}</b>
          <span>{def.category} · <code>{node.id}</code></span>
        </div>
        <button className="ghost icon danger" onClick={onDelete} title="Delete block"><Trash2 size={15} /></button>
      </div>
      <div className="tabs">
        <button className={tab === 'settings' ? 'on' : ''} onClick={() => setTab('settings')}>Settings</button>
        <button className={tab === 'run' ? 'on' : ''} onClick={() => setTab('run')}>
          Last run {steps.length > 0 && <span className={'dot ' + steps[steps.length - 1].status} />}
        </button>
      </div>

      {tab === 'settings' ? (
        <div className="inspector">
          <p className="muted small" style={{ margin: 0 }}>{def.description}</p>
          <label>Name<input value={node.data.label ?? ''} placeholder={def.label} onChange={(e) => onChange({ label: e.target.value })} /></label>

          {def.fields.map((f) => (
            <label key={f.key}>
              {f.label}
              {f.kind === 'textarea' ? (
                <textarea rows={4} value={cfg[f.key] ?? ''} placeholder={f.placeholder} onFocus={(e) => (focus.current = { key: f.key, el: e.target })} onChange={(e) => set(f.key, e.target.value)} />
              ) : f.kind === 'select' ? (
                <select value={cfg[f.key] ?? f.default ?? ''} onChange={(e) => set(f.key, e.target.value)}>
                  {f.options!.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : f.kind === 'number' ? (
                <input type="number" value={cfg[f.key] ?? f.default ?? ''} onChange={(e) => set(f.key, Number(e.target.value))} />
              ) : f.kind === 'tools' ? (
                <div className="tools">
                  {tools.map((t) => {
                    const on = (cfg[f.key] ?? []).includes(t.name);
                    return (
                      <label key={t.name} className="row tool">
                        <input type="checkbox" checked={on} onChange={() => set(f.key, on ? cfg[f.key].filter((x: string) => x !== t.name) : [...(cfg[f.key] ?? []), t.name])} />
                        <span><code>{t.name}</code> {t.write && <span className="badge warn">writes</span>}</span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <input value={cfg[f.key] ?? ''} placeholder={f.placeholder} onFocus={(e) => (focus.current = { key: f.key, el: e.target })} onChange={(e) => set(f.key, e.target.value)} />
              )}
              {f.help && <span className="field-help">{f.help}</span>}
            </label>
          ))}

          {def.category !== 'Trigger' && (
            <label className="row"><input type="checkbox" checked={!!cfg.continueOnError} onChange={(e) => set('continueOnError', e.target.checked)} /> Continue if this step fails</label>
          )}

          {def.category !== 'Trigger' && (
            <div className="refs">
              <div className="label">Insert data from earlier steps</div>
              <span className="field-help">Click a text field, then a chip.</span>
              <div className="chips">{chip('{{trigger.input}}')}{chip('{{trigger.recordId}}')}{chip('{{trigger.context}}')}</div>
              {inLoop && <div className="chips">{chip('{{item}}')}{chip('{{index}}')}{chip('{{item.Name}}')}</div>}
              {refs.map((r) => (
                <div key={r.id} className="refgroup">
                  <span className="field-help">{r.label}</span>
                  <div className="chips">{r.keys.map((k) => chip(`{{${r.id}.${k}}}`))}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="inspector">
          {steps.length === 0 ? (
            <span className="muted small">This block hasn't run yet. Use Test run below.</span>
          ) : steps.map((s, i) => (
            <div key={i} className="refgroup">
              <div className="row small">
                <span className={'dot ' + s.status} /> {s.status}{s.iteration !== undefined ? ` · item ${s.iteration + 1}` : ''}{s.reused && <span className="badge ok">reused · $0</span>}
                <span className="muted" style={{ marginLeft: 'auto' }}>{s.ms} ms</span>
              </div>
              {s.error && <div className="err">{s.error}</div>}
              <pre className="out">{JSON.stringify(s.output ?? null, null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
