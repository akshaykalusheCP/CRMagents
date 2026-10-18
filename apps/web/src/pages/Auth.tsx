import { ArrowUpRight, ChevronRight, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { LogoMark } from '../components/Logo';
import { PublicFooter } from './Legal';
import { Pricing } from '../components/Pricing';
import { api } from '../api';
import { Ribbon } from '../components/Ribbon';

// Signed-out home: hero with the sign-in card, then three small, real-looking previews of what the product does.

type Mode = 'login' | 'signup' | 'forgot' | 'reset' | 'invite';
const ROLE_NAME: Record<string, string> = { admin: 'an admin', builder: 'a builder', approver: 'an approver', owner: 'an owner' };

/** Removes ?invite= / ?reset= from the address once used, so a refresh doesn't reuse the link. */
const dropToken = () => { const u = new URL(location.href); u.searchParams.delete('invite'); u.searchParams.delete('reset'); history.replaceState(null, '', u.pathname + (u.search ? u.search : '')); };

export function AuthPage({ onDone }: { onDone: () => void }) {
  const q = new URLSearchParams(location.search);
  const token = q.get('invite') ?? q.get('reset') ?? '';
  const [mode, setMode] = useState<Mode>(q.get('invite') ? 'invite' : q.get('reset') ? 'reset' : 'login');
  const [f, setF] = useState({ accountName: '', email: '', password: '' });
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [planPick, setPlanPick] = useState<string | undefined>();
  const [invite, setInvite] = useState<{ email: string; role: string; invitedBy: string | null; accountName: string } | null>(null);

  useEffect(() => {
    if (mode !== 'invite' || !token) return;
    api.invite(token).then(setInvite).catch((e) => setErr((e as Error).message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr(''); setNote('');
    try {
      if (mode === 'login') await api.login(f.email, f.password);
      else if (mode === 'signup') await api.signup({ ...f, plan: planPick });
      else if (mode === 'forgot') {
        await api.forgot(f.email);
        setNote('If that email has a CRMagents login, a reset link is on its way. It works for 2 hours. No email? Ask an admin in your company for a reset link.');
        setBusy(false);
        return;
      } else if (mode === 'reset') { await api.resetPassword(token, f.password); dropToken(); }
      else { await api.acceptInvite(token, f.password); dropToken(); }
      onDone();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  const go = (m: Mode) => { if (m === 'login' || m === 'signup') dropToken(); setMode(m); setErr(''); setNote(''); document.getElementById('auth-email')?.focus(); };
  const title = { login: 'Log in to your workspace', signup: 'Create your workspace', forgot: 'Reset your password', reset: 'Choose a new password', invite: invite ? `Join ${invite.accountName}` : 'Join your team' }[mode];
  const action = { login: 'Log in', signup: 'Create account', forgot: 'Send reset link', reset: 'Save password', invite: 'Join workspace' }[mode];
  const needsEmail = mode === 'login' || mode === 'signup' || mode === 'forgot';
  // A dead invitation link: say so, and offer only the way back.
  const deadInvite = mode === 'invite' && !invite && !!err;
  const needsPassword = mode !== 'forgot' && !deadInvite;
  const newPassword = mode !== 'login';

  return (
    <div className="landing">
      <header className="land-nav">
        <div className="land-inner">
          <span className="land-brand"><span className="brand-mark"><LogoMark size={15} /></span>CRMagents</span>
          <nav className="land-links" aria-label="Product">
            <a href="#agents">Agents</a><a href="#insights">Insights</a><a href="#dashboards">Dashboards</a><a href="#pricing">Pricing</a><a href="/contact">Contact</a>
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

          <form className="land-card" onSubmit={submit} aria-label={title}>
            <h2>{title}</h2>
            {mode === 'invite' && invite && (
              <p className="auth-lede">{invite.invitedBy ?? 'Your team'} invited <b>{invite.email}</b> to join as {ROLE_NAME[invite.role] ?? invite.role}. Choose a password to get started.</p>
            )}
            {mode === 'reset' && <p className="auth-lede">Choose a new password. You'll be signed out on your other devices.</p>}
            {mode === 'forgot' && <p className="auth-lede">Enter the email you log in with and we'll send you a link to choose a new password.</p>}
            {mode === 'signup' && planPick && planPick !== 'basic' && (
              <p className="auth-lede">You picked {planPick === 'pro' ? 'Pro' : 'Plus'}. Every workspace starts with a 14-day free trial; we'll help you move to {planPick === 'pro' ? 'Pro' : 'Plus'} when you're ready.</p>
            )}
            {mode === 'signup' && (
              <label>Company name<input id="auth-company" value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} required /></label>
            )}
            {needsEmail && <label>Email<input id="auth-email" type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>}
            {needsPassword && (
              <label>
                <span className="auth-label-row">{newPassword ? 'New password' : 'Password'}
                  {mode === 'login' && <button type="button" className="auth-forgot" onClick={() => go('forgot')}>Forgot password?</button>}
                </span>
                <input id="auth-password" type="password" autoComplete={newPassword ? 'new-password' : 'current-password'} minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
                {newPassword && <span className="muted small">At least 10 characters.</span>}
              </label>
            )}
            {err && <div className="err">{err}</div>}
            {note && <div className="auth-note">{note}</div>}
            {!deadInvite && <button className="land-btn primary wide" disabled={busy || (mode === 'invite' && !invite)}>{action} <ChevronRight size={15} /></button>}
            {mode === 'login' || mode === 'signup' ? (
              <button type="button" className="land-switch" onClick={() => go(mode === 'login' ? 'signup' : 'login')}>
                {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
              </button>
            ) : (
              <button type="button" className="land-switch" onClick={() => go('login')}>Back to log in</button>
            )}
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
      <Pricing onStart={(p) => { setPlanPick(p); go('signup'); window.scrollTo({ top: 0, behavior: 'smooth' }); }} />
      <PublicFooter />
    </div>
  );
}
