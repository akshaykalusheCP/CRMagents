import { ArrowUpRight, ChevronRight, ShieldCheck, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { Ribbon } from '../components/Ribbon';

// Signed-out home: hero with the sign-in card, then three small, real-looking previews of what the product does.

export function AuthPage({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [f, setF] = useState({ accountName: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      if (mode === 'login') await api.login(f.email, f.password);
      else await api.signup(f);
      onDone();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const go = (m: 'login' | 'signup') => { setMode(m); setErr(''); document.getElementById('auth-email')?.focus(); };

  return (
    <div className="landing">
      <header className="land-nav">
        <div className="land-inner">
          <span className="land-brand"><span className="brand-mark"><Sparkles size={14} /></span>CRMagents</span>
          <nav className="land-links" aria-label="Product">
            <a href="#agents">Agents</a><a href="#insights">Insights</a><a href="#dashboards">Dashboards</a>
          </nav>
          <div className="land-cta">
            <button className="land-btn ghost" onClick={() => go('login')}>Log in</button>
            <button className="land-btn primary" onClick={() => go('signup')}>Start free <ChevronRight size={15} /></button>
          </div>
        </div>
      </header>

      <section className="land-hero">
        <Ribbon className="land-ribbon" />
        <div className="land-inner land-hero-grid">
          <div className="land-copy">
            <p className="land-eyebrow"><span>AI agents for Salesforce</span> · no Agentforce licence needed</p>
            <h1 className="land-title">
              Agents for Salesforce, built in plain English. <span>Describe the job and get a working agent in under a minute.</span>
            </h1>
            <div className="land-points">
              <span><ShieldCheck size={16} /> Approval before every change</span>
              <span><ShieldCheck size={16} /> Uses your own Flows and Apex</span>
              <span><ShieldCheck size={16} /> Pay only for what runs</span>
            </div>
          </div>

          <form className="land-card" onSubmit={submit} aria-label={mode === 'login' ? 'Log in' : 'Create account'}>
            <h2>{mode === 'login' ? 'Log in to your workspace' : 'Create your workspace'}</h2>
            {mode === 'signup' && (
              <label>Company name<input id="auth-company" value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} required /></label>
            )}
            <label>Email<input id="auth-email" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
            <label>Password<input id="auth-password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
              {mode === 'signup' && <span className="muted small">At least 10 characters.</span>}
            </label>
            {err && <div className="err">{err}</div>}
            <button className="land-btn primary wide" disabled={busy}>{mode === 'login' ? 'Log in' : 'Create account'} <ChevronRight size={15} /></button>
            <button type="button" className="land-switch" onClick={() => go(mode === 'login' ? 'signup' : 'login')}>
              {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
            </button>
          </form>
        </div>
      </section>

      <section className="land-section">
        <div className="land-inner">
          <h2 className="land-h2">Everything an admin needs in one place. <span>Build agents, watch the business, and share dashboards, all from your Salesforce data.</span></h2>
          <div className="bento">
            <article className="bento-card wide wash-violet" id="agents">
              <div className="bento-head"><h3>Build an agent by chatting</h3><span className="bento-icon" aria-hidden="true"><ArrowUpRight size={14} /></span></div>
              <div className="mock-split">
                <div className="mock mock-chat" aria-hidden="true">
                  <div className="m-msg me">Follow up on escalated cases</div>
                  <div className="m-msg ai">Which cases, and what should start it?</div>
                  <div className="m-chips"><span>When a case is escalated</span><span>Every new case</span></div>
                  <div className="m-msg ai">Built “Escalated case follow-up”.</div>
                </div>
                <div className="mock mock-agent" aria-hidden="true">
                  <b>Escalated case follow-up</b>
                  <small>WHEN IT RUNS</small><span>A Case is updated</span>
                  <small>STEPS</small><span>1. Runs Flow: Add Case Comment</span><span>2. Creates a follow-up task</span>
                  <em><ShieldCheck size={12} /> Asks before changing anything</em>
                </div>
              </div>
            </article>

            <article className="bento-card wash-sunset" id="insights">
              <div className="bento-head"><h3>Your business, briefed</h3><span className="bento-icon" aria-hidden="true"><ArrowUpRight size={14} /></span></div>
              <div className="mock mock-brief" aria-hidden="true">
                <small>Open pipeline</small>
                <b>$2.1M</b>
                <div className="m-meter"><span style={{ width: '64%' }} /></div>
                <div className="m-bars">{[32, 48, 40, 66, 58, 80, 72, 94, 70, 88, 76, 100].map((v, i) => <i key={i} style={{ height: `${v}%` }} />)}</div>
                <span className="m-note">3 deals need attention this week</span>
              </div>
            </article>

            <article className="bento-card wash-sky" id="dashboards">
              <div className="bento-head"><h3>Dashboards from a sentence</h3><span className="bento-icon" aria-hidden="true"><ArrowUpRight size={14} /></span></div>
              <div className="mock mock-table" aria-hidden="true">
                <div className="m-prompt">Pipeline by stage and my biggest open deals</div>
                {[['Needs analysis', 92], ['Negotiation', 58], ['Proposal', 54], ['Value proposition', 48], ['Prospecting', 16]].map(([l, v]) => (
                  <div key={l as string} className="m-row"><span>{l}</span><i style={{ width: `${v}%` }} /></div>
                ))}
              </div>
            </article>

            <article className="bento-card wide navy">
              <div className="bento-head"><h3>Keeps your org safe by design</h3></div>
              <p className="navy-lede">Agents read your data freely and change it only with a person's approval.</p>
              <div className="safe-grid">
                <div><b>Read-only by default</b><span>Queries are checked and capped before they reach Salesforce.</span></div>
                <div><b>Approval before writes</b><span>A person approves every change an agent wants to make.</span></div>
                <div><b>Spend limits</b><span>A daily AI budget per workspace, and answers reused when nothing changed.</span></div>
              </div>
            </article>
          </div>
        </div>
      </section>
      <footer className="land-foot"><div className="land-inner">CRMagents · AI agents and analytics for Salesforce</div></footer>
    </div>
  );
}
