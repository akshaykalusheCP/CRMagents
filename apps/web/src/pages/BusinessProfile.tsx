import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Me, type Tenant } from '../api';
import { Panel, toast, useConfirm } from '../components/ui';

// The business profile: what the company wants every agent and assistant to know about it. Sent first on every AI
// call and cached, so it costs a fraction of a cent per call, and it lets the low-cost model do work that would
// otherwise need the strongest one.

const MAX = 12_000;
const TEMPLATE = `What we do
-

Our customers
-

Products and services
-

Words we use
-

How we handle cases and deals
-

Rules and tone for agents
- `;

export function BusinessProfilePage({ me, tenant }: { me: Me; tenant?: Tenant }) {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'draft'>('');
  const [confirmUi, ask] = useConfirm();
  const admin = me.role === 'owner' || me.role === 'admin';
  useEffect(() => { api.settings().then((s) => { setText(s.businessProfile ?? ''); setSaved(s.businessProfile ?? ''); }).catch((e) => toast((e as Error).message, 'bad')); }, []);

  const save = async () => {
    setBusy('save');
    try { await api.saveSettings({ businessProfile: (text ?? '').trim() }); setSaved((text ?? '').trim()); toast('Business profile saved'); }
    catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(''); }
  };
  const draft = async () => {
    if (!tenant) return;
    if ((text ?? '').trim() && !(await ask({ title: 'Replace it with a new draft?', body: 'What is in the box now is replaced by a draft written from your Salesforce org. Nothing is saved until you click Save.', confirm: 'Draft from Salesforce' }))) return;
    setBusy('draft');
    try { setText((await api.draftBusinessProfile(tenant.id)).text); toast('Draft ready: check it, fill in the [brackets], then save'); }
    catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(''); }
  };

  if (text === null) return <Panel><Loader2 size={16} className="spin" /></Panel>;
  const dirty = text.trim() !== saved;
  return (
    <div className="smart-col">
      {confirmUi}
      <Panel title="About your company" action={admin && tenant && (
        <button className="sm" onClick={() => void draft()} disabled={!!busy}>{busy === 'draft' ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />} Draft from Salesforce</button>
      )}>
        <p className="muted small" style={{ margin: '0 0 12px' }}>
          Every agent and assistant reads this before it works, like a new colleague's first-day notes: what you sell, who your customers are, what your terms mean, and your rules.
          The clearer it is, the more work the low-cost model can do on its own. It is sent with every AI request (cached, so it costs a fraction of a cent), so leave out passwords and personal data.
        </p>
        <textarea className="profile-text" value={text} onChange={(e) => setText(e.target.value)} placeholder={TEMPLATE} rows={18} maxLength={MAX} disabled={!admin} aria-label="Business profile" />
        <div className="row between" style={{ marginTop: 10 }}>
          <span className={`small ${text.length > MAX * 0.9 ? 'warn-text' : 'muted'}`}>{text.length.toLocaleString()} / {MAX.toLocaleString()} characters</span>
          {admin && (
            <span className="row" style={{ gap: 8 }}>
              {!text.trim() && <button className="sm" onClick={() => setText(TEMPLATE)}>Start from headings</button>}
              <button className="primary sm" onClick={() => void save()} disabled={!dirty || !!busy}>{busy === 'save' ? <Loader2 size={14} className="spin" /> : null} Save</button>
            </span>
          )}
        </div>
        {!admin && <p className="muted small" style={{ margin: '8px 0 0' }}>Only admins can change the business profile.</p>}
      </Panel>
      <Panel title="What makes a good profile">
        <ul className="tips">
          <li><b>Your words.</b> What "Outage", "Partner" or "Tier 1" mean at your company: the AI otherwise guesses.</li>
          <li><b>Your rules.</b> "Refunds over $500 need a manager", "Never promise delivery dates".</li>
          <li><b>Who to send things to.</b> Which team handles billing, outages or renewals.</li>
          <li><b>Short beats long.</b> A page is plenty. Detailed procedures belong in Knowledge, where agents look them up when needed.</li>
        </ul>
      </Panel>
    </div>
  );
}
