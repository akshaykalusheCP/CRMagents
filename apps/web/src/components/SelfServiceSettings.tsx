import { Loader2, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import type { SelfService } from '../api';

// What website visitors can do for themselves once they prove their email with a code.

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export function SelfServiceSettings({ value, onSave }: { value: SelfService; onSave: (v: SelfService) => Promise<void> }) {
  const [v, setV] = useState<SelfService>(value);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(v) !== JSON.stringify(value);
  const set = (p: Partial<SelfService>) => setV({ ...v, ...p });
  const setRec = (i: number, p: Partial<SelfService['records'][number]>) => set({ records: v.records.map((r, j) => (j === i ? { ...r, ...p } : r)) });
  const m = v.meetings ?? { enabled: false, with: [], durationMin: 30, days: 10, subject: 'Meeting' };
  const setM = (p: Partial<SelfService['meetings']>) => set({ meetings: { ...m, ...p } });
  const setAct = (i: number, p: Partial<SelfService['actions'][number]>) => set({ actions: v.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });

  return (
    <div className="ss">
      <label className="row small" style={{ gap: 8 }}>
        <input type="checkbox" checked={v.verify} onChange={(e) => set({ verify: e.target.checked })} />
        <b>Let visitors see and manage their own information</b>
      </label>
      <p className="muted small" style={{ margin: '2px 0 10px 24px' }}>They prove their email with a 6-digit code (sent from your Salesforce org). Only then does the assistant see anything about them, and only what you list here.</p>

      {v.verify && <div className="ss-body">
        <div className="ss-h">What they can see</div>
        {v.records.map((r, i) => (
          <div key={i} className="ss-row">
            <input value={r.label} onChange={(e) => setRec(i, { label: e.target.value })} placeholder="Your orders" aria-label="Label" style={{ width: 140 }} />
            <input value={r.object} onChange={(e) => setRec(i, { object: e.target.value })} placeholder="Order" aria-label="Object" style={{ width: 110 }} />
            <select value={r.match} onChange={(e) => setRec(i, { match: e.target.value as 'contact' })} aria-label="Linked by">
              <option value="contact">linked to their contact</option>
              <option value="account">linked to their account</option>
              <option value="email">with their email in a field</option>
            </select>
            {r.match === 'email' && <input value={r.emailField ?? ''} onChange={(e) => setRec(i, { emailField: e.target.value })} placeholder="SuppliedEmail" aria-label="Email field" style={{ width: 120 }} />}
            <input value={r.fields.join(', ')} onChange={(e) => setRec(i, { fields: list(e.target.value) })} placeholder="OrderNumber, Status, TotalAmount" aria-label="Fields shown" style={{ flex: 1, minWidth: 180 }} />
            <button className="ghost icon sm" onClick={() => set({ records: v.records.filter((_, j) => j !== i) })} aria-label="Remove"><Trash2 size={14} /></button>
          </div>
        ))}
        <button className="sm" onClick={() => set({ records: [...v.records, { object: '', label: '', match: 'account', fields: [] }] })}><Plus size={13} /> Add</button>

        <div className="ss-h">What they can do</div>
        <p className="muted small" style={{ margin: '0 0 6px' }}>Your own Flows or Apex actions (key like <code>flow:Start_Return</code>). Nimbus adds <code>contactId</code>, <code>accountId</code> and <code>customerEmail</code> of the verified visitor; your Flow should check them.</p>
        {v.actions.map((a, i) => (
          <div key={i} className="ss-row">
            <input value={a.label} onChange={(e) => setAct(i, { label: e.target.value })} placeholder="Start a return" aria-label="Label" style={{ width: 160 }} />
            <input value={a.key} onChange={(e) => setAct(i, { key: e.target.value })} placeholder="flow:Start_Return" aria-label="Action key" style={{ width: 200 }} />
            <input value={a.description ?? ''} onChange={(e) => setAct(i, { description: e.target.value })} placeholder="When to use it (optional)" aria-label="Description" style={{ flex: 1, minWidth: 160 }} />
            <button className="ghost icon sm" onClick={() => set({ actions: v.actions.filter((_, j) => j !== i) })} aria-label="Remove"><Trash2 size={14} /></button>
          </div>
        ))}
        <button className="sm" onClick={() => set({ actions: [...v.actions, { key: '', label: '' }] })}><Plus size={13} /> Add</button>

        <div className="ss-h">Details they can change</div>
        <input value={v.updatable.join(', ')} onChange={(e) => set({ updatable: list(e.target.value) })} placeholder="Phone, MailingStreet, MailingCity, MailingPostalCode" aria-label="Contact fields" style={{ width: '100%' }} />
      </div>}

      <label className="row small" style={{ gap: 8, marginTop: 12 }}>
        <input type="checkbox" checked={v.handoff} onChange={(e) => set({ handoff: e.target.checked })} />
        <b>Hand over to a person</b> <span className="muted">opens a case with the conversation; your team replies by email</span>
      </label>

      <label className="row small" style={{ gap: 8, marginTop: 12 }}>
        <input type="checkbox" checked={m.enabled} onChange={(e) => setM({ enabled: e.target.checked })} />
        <b>Book meetings</b> <span className="muted">visitors pick a free time on your team's Salesforce calendars; no code needed</span>
      </label>
      {m.enabled && <div className="ss-body">
        <div className="ss-h">With whom</div>
        <input value={m.with.join(', ')} onChange={(e) => setM({ with: list(e.target.value) })} placeholder="sales@acme.com, priya@acme.com" aria-label="People to book with" style={{ width: '100%' }} />
        <p className="muted small" style={{ margin: '4px 0 0' }}>Salesforce users' emails. With several, each time goes to whoever is free (round-robin). Times are 9:00-17:00 on weekdays in each person's Salesforce time zone, skipping their Events.</p>
        <div className="ss-row" style={{ marginTop: 10 }}>
          <input value={m.subject} onChange={(e) => setM({ subject: e.target.value })} placeholder="Demo" aria-label="Meeting name" style={{ width: 160 }} />
          <select value={m.durationMin} onChange={(e) => setM({ durationMin: Number(e.target.value) })} aria-label="Length">
            {[15, 20, 30, 45, 60].map((n) => <option key={n} value={n}>{n} minutes</option>)}
          </select>
          <select value={m.days} onChange={(e) => setM({ days: Number(e.target.value) })} aria-label="How far ahead">
            {[3, 5, 7, 10, 14, 21, 30].map((n) => <option key={n} value={n}>next {n} days</option>)}
          </select>
        </div>
        <p className="muted small" style={{ margin: '6px 0 0' }}>The meeting goes on their calendar linked to the visitor (an existing contact or lead, or a new lead), and the visitor gets a confirmation email.</p>
      </div>}

      {dirty && <div className="row" style={{ gap: 8, marginTop: 12 }}>
        <button className="primary sm" disabled={busy} onClick={async () => { setBusy(true); try { await onSave(v); } finally { setBusy(false); } }}>{busy ? <Loader2 size={13} className="spin" /> : null} Save self-service</button>
        <button className="sm" onClick={() => setV(value)}>Discard</button>
      </div>}
    </div>
  );
}
