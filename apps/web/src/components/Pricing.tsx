import { Check, ChevronRight, Loader2, X } from 'lucide-react';
import { useState } from 'react';

// Plans on the signed-out page. Prices are per workspace; AI usage is paid to your own AI provider on Basic and
// at cost on the paid plans (or bring your own key on any plan).

interface Plan { id: string; name: string; tagline: string; monthly: number | null; cta: string; highlight?: boolean; intro: string; features: string[] }

const PLANS: Plan[] = [
  {
    id: 'basic', name: 'Basic', tagline: 'Try it on your own org', monthly: 0, cta: 'Start free trial',
    intro: '14 days free, with your own AI key',
    features: [
      '1 Salesforce org, up to 3 people',
      '3 live agents and 2 assistants',
      'Build agents by chatting, use-case library',
      'Approval before every change, one-click undo',
      'Alerts and auto-pause when an agent keeps failing',
      'Discover: what to automate in your org',
      'Bring your own Claude, OpenAI or Gemini key',
      'Community support',
    ],
  },
  {
    id: 'plus', name: 'Plus', tagline: 'For a team putting agents to work', monthly: 49, cta: 'Start with Plus',
    intro: 'Everything in Basic, plus',
    features: [
      '2 orgs, up to 10 people, 15 live agents',
      'Unlimited assistants, with memory and saved chats',
      'Nimbus panel inside Salesforce, Flow actions',
      'Knowledge base, synced from Salesforce Knowledge',
      'Email replies on cases',
      'Insights and dashboards from a sentence',
      'Assistant test sets, monthly cost caps',
      'Email support',
    ],
  },
  {
    id: 'pro', name: 'Pro', tagline: 'For service and sales at scale', monthly: 199, cta: 'Start with Pro', highlight: true,
    intro: 'Everything in Plus, plus',
    features: [
      '5 orgs, unlimited people and agents',
      'Website chat with customer self-service',
      'SMS and WhatsApp, meeting booking',
      'Build & prove on your records, learn from your team',
      'Automation X-ray of Flows, triggers and rules',
      'Impact and ROI reporting',
      'Trust center: AI call log, activity log, export',
      'Priority support',
    ],
  },
  {
    id: 'promax', name: 'Pro Max', tagline: 'Shaped around your business', monthly: null, cta: 'Contact sales',
    intro: 'Everything in Pro, plus',
    features: [
      'Unlimited orgs and sandboxes',
      'Private hosting and your choice of region',
      'Single sign-on, custom data retention',
      'Security review support and a DPA',
      'Agents designed and built with your team',
      'One agent rolled out to many client orgs (partners)',
      'SLA and a dedicated success manager',
    ],
  },
];

function SalesForm({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', email: '', company: '', size: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/sales-inquiry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? 'Could not send. Try again.');
      setDone(true);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="pr-modal" role="dialog" aria-label="Contact sales" onClick={onClose}>
      <form className="land-card pr-form" onSubmit={send} onClick={(e) => e.stopPropagation()}>
        <button type="button" className="pr-close" onClick={onClose} aria-label="Close"><X size={18} /></button>
        {done ? <>
          <h2>Thanks, we'll be in touch</h2>
          <p className="pr-lede">Our team will reply within one business day to plan Pro Max around your orgs, data and goals.</p>
          <button type="button" className="land-btn primary wide" onClick={onClose}>Close</button>
        </> : <>
          <h2>Talk to sales</h2>
          <p className="pr-lede">Tell us a little about your team and we'll shape a plan around it.</p>
          <label>Your name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} /></label>
          <label>Work email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required maxLength={200} /></label>
          <label>Company<input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} required maxLength={160} /></label>
          <label>Salesforce users<input value={f.size} onChange={(e) => setF({ ...f, size: e.target.value })} placeholder="e.g. 250" maxLength={40} /></label>
          <label>What would you like agents to do?<textarea value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} rows={3} maxLength={2000} /></label>
          {err && <div className="err">{err}</div>}
          <button className="land-btn primary wide" disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : null} Send <ChevronRight size={15} /></button>
        </>}
      </form>
    </div>
  );
}

export function Pricing({ onStart }: { onStart: (plan: string) => void }) {
  const [yearly, setYearly] = useState(false);
  const [sales, setSales] = useState(false);
  const price = (p: Plan) => (p.monthly === null ? null : yearly ? Math.round((p.monthly * 10) / 12) : p.monthly);
  return (
    <section className="land-section pricing" id="pricing">
      <div className="land-inner">
        <div className="pr-head">
          <h2 className="land-h2">Pricing that grows with you. <span>Start free with your own AI key, upgrade when agents are doing real work.</span></h2>
          <div className="pr-toggle" role="radiogroup" aria-label="Billing period">
            <button type="button" role="radio" aria-checked={!yearly} className={!yearly ? 'on' : ''} onClick={() => setYearly(false)}>Monthly</button>
            <button type="button" role="radio" aria-checked={yearly} className={yearly ? 'on' : ''} onClick={() => setYearly(true)}>Yearly <em>2 months free</em></button>
          </div>
        </div>
        <div className="pr-grid">
          {PLANS.map((p) => {
            const v = price(p);
            return (
              <article key={p.id} className={'pr-card' + (p.highlight ? ' hi' : '')}>
                {p.highlight && <span className="pr-badge">Most popular</span>}
                <h3>{p.name}</h3>
                <p className="pr-tag">{p.tagline}</p>
                <div className="pr-price">
                  {v === null ? <b className="pr-custom">Custom</b> : v === 0 ? <><b>Free</b><span>for 14 days</span></> : <><b>${v}</b><span>/ month{yearly ? ', billed yearly' : ''}</span></>}
                </div>
                <button type="button" className={'land-btn wide ' + (p.highlight ? 'primary' : 'outline')} onClick={() => (p.monthly === null ? setSales(true) : onStart(p.id))}>
                  {p.cta} <ChevronRight size={15} />
                </button>
                <p className="pr-intro">{p.intro}</p>
                <ul>{p.features.map((x) => <li key={x}><Check size={15} />{x}</li>)}</ul>
              </article>
            );
          })}
        </div>
        <p className="pr-note">Prices per workspace, before tax. AI usage on paid plans is billed at cost, or use your own AI key on any plan. Cancel any time.</p>
      </div>
      {sales && <SalesForm onClose={() => setSales(false)} />}
    </section>
  );
}
