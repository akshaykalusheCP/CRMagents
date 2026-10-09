import { useState } from 'react';
import { api } from '../api';

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

  return (
    <div className="auth">
      <form className="card" onSubmit={submit}>
        <h2>CRMagents</h2>
        <p className="muted">{mode === 'login' ? 'Log in to your workspace' : 'Create your workspace'}</p>
        {mode === 'signup' && (
          <label>Company name<input value={f.accountName} onChange={(e) => setF({ ...f, accountName: e.target.value })} required /></label>
        )}
        <label>Email<input type="email" autoComplete="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
        <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={10} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required />
          {mode === 'signup' && <span className="muted small">At least 10 characters.</span>}
        </label>
        {err && <div className="err">{err}</div>}
        <button className="primary" disabled={busy}>{mode === 'login' ? 'Log in' : 'Create account'}</button>
        <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setErr(''); }}>
          {mode === 'login' ? 'New here? Create an account' : 'Already have an account? Log in'}
        </button>
      </form>
    </div>
  );
}
