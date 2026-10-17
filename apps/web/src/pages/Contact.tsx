import { Briefcase, ChevronRight, CreditCard, Handshake, LifeBuoy, Loader2, MessageSquare } from 'lucide-react';
import { useState } from 'react';
import { LogoMark } from '../components/Logo';
import { Ribbon } from '../components/Ribbon';

// Contact page (public, /contact): sales, support, partnerships, billing. Messages are kept for CRMagents staff in
// Super admin → Requests. Email delivery and routing are configured later.

const TOPICS = [
  { id: 'sales', label: 'Sales', icon: <Briefcase size={18} />, text: 'Plans, Pro Max, a demo on your org' },
  { id: 'support', label: 'Support', icon: <LifeBuoy size={18} />, text: 'Something not working as expected' },
  { id: 'partnership', label: 'Partnerships', icon: <Handshake size={18} />, text: 'Salesforce consultancies and resellers' },
  { id: 'billing', label: 'Billing', icon: <CreditCard size={18} />, text: 'Invoices, payments, your subscription' },
  { id: 'other', label: 'Something else', icon: <MessageSquare size={18} />, text: 'Press, security reviews, anything' },
] as const;
type Topic = (typeof TOPICS)[number]['id'];

export function ContactPage() {
  const initial = new URLSearchParams(location.search).get('topic') as Topic | null;
  const [topic, setTopic] = useState<Topic>(TOPICS.some((t) => t.id === initial) ? initial! : 'sales');
  const [f, setF] = useState({ name: '', email: '', company: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const res = await fetch('/api/contact', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...f, topic }) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? 'Could not send. Try again.');
      setDone(true);
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <div className="landing">
      <header className="land-nav">
        <div className="land-inner">
          <a className="land-brand" href="/" style={{ color: 'inherit', textDecoration: 'none' }}><span className="brand-mark"><LogoMark size={15} /></span>CRMagents</a>
          <nav className="land-links" aria-label="Product"><a href="/#agents">Product</a><a href="/#pricing">Pricing</a><a href="/contact" aria-current="page">Contact</a></nav>
          <div className="land-cta"><a className="land-btn ghost" href="/">Log in</a></div>
        </div>
      </header>
      <section className="land-hero contact-hero">
        <Ribbon className="land-ribbon" palette="ocean" />
        <div className="land-inner contact-grid">
          <div className="land-copy">
            <h1 className="land-title">Talk to us. <span>Questions about plans, help with your org, or working together: we reply within one business day.</span></h1>
            <div className="contact-topics" role="radiogroup" aria-label="Topic">
              {TOPICS.map((t) => (
                <button key={t.id} type="button" role="radio" aria-checked={topic === t.id} className={'contact-topic' + (topic === t.id ? ' on' : '')} onClick={() => setTopic(t.id)}>
                  {t.icon}<span><b>{t.label}</b><small>{t.text}</small></span>
                </button>
              ))}
            </div>
          </div>
          <form className="land-card" onSubmit={send} aria-label="Contact form">
            {done ? <>
              <h2>Thanks, message received</h2>
              <p className="auth-lede">We'll reply to {f.email} within one business day.</p>
              <a className="land-btn primary wide" href="/">Back to CRMagents</a>
            </> : <>
              <h2>{TOPICS.find((t) => t.id === topic)!.label}</h2>
              <label>Your name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} /></label>
              <label>Email<input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required maxLength={200} /></label>
              <label>Company <span className="muted">(optional)</span><input value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} maxLength={160} /></label>
              <label>Message<textarea className="contact-msg" value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} required minLength={5} maxLength={4000} rows={5} /></label>
              {err && <div className="err">{err}</div>}
              <button className="land-btn primary wide" disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : null} Send message <ChevronRight size={15} /></button>
            </>}
          </form>
        </div>
      </section>
      <footer className="land-foot"><div className="land-inner">CRMagents · AI agents and analytics for Salesforce · <a href="/contact">Contact</a></div></footer>
    </div>
  );
}
