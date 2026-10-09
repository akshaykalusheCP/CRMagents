import { useEffect, useState } from 'react';
import { api, type Settings } from '../api';

export function SettingsPage() {
  const [s, setS] = useState<Settings>();
  const [form, setForm] = useState({ sfClientId: '', sfClientSecret: '', sfLoginUrl: '', anthropicKey: '', dailyBudgetUsd: '', anthropicWorkspaceId: '', aiCacheHours: '' });
  const [msg, setMsg] = useState('');

  const load = () => api.settings().then((x) => {
    setS(x);
    setForm((f) => ({ ...f, sfClientId: x.sfClientId, sfLoginUrl: x.sfLoginUrl, sfClientSecret: '', anthropicKey: '', dailyBudgetUsd: x.dailyBudgetUsd ?? '', anthropicWorkspaceId: x.anthropicWorkspaceId ?? '', aiCacheHours: x.aiCacheHours ?? '' }));
  });
  useEffect(() => { load().catch((e) => setMsg(e.message)); }, []);

  const save = async () => {
    try {
      // Secret fields are only sent when the user typed something, so blank never wipes a stored value.
      const body: Record<string, string> = { sfClientId: form.sfClientId, sfLoginUrl: form.sfLoginUrl, dailyBudgetUsd: form.dailyBudgetUsd.trim(), anthropicWorkspaceId: form.anthropicWorkspaceId.trim(), aiCacheHours: form.aiCacheHours.trim() };
      if (form.sfClientSecret) body.sfClientSecret = form.sfClientSecret;
      if (form.anthropicKey) body.anthropicKey = form.anthropicKey;
      await api.saveSettings(body);
      setMsg('Saved.');
      await load();
    } catch (e) { setMsg((e as Error).message); }
  };

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page narrow">
      <h2>Settings</h2>
      <p className="muted">Credentials are stored encrypted and are never shown again after saving.</p>

      <section className="card">
        <h3>Salesforce app</h3>
        <p className="muted small">
          In Salesforce Setup create an External Client App (or Connected App) with OAuth enabled, scopes
          <b> api</b> and <b>refresh_token</b>, PKCE on, and this callback URL:
        </p>
        <code className="copy">{s?.callbackUrl}</code>
        <label>Consumer Key<input value={form.sfClientId} onChange={set('sfClientId')} placeholder="3MVG9..." /></label>
        <label>Consumer Secret {s?.sfClientSecret.set && <span className="badge ok">saved</span>}
          <input type="password" value={form.sfClientSecret} onChange={set('sfClientSecret')} placeholder={s?.sfClientSecret.set ? '•••••••• (leave blank to keep)' : 'optional with PKCE'} />
        </label>
        <label>Login URL (optional)<input value={form.sfLoginUrl} onChange={set('sfLoginUrl')} placeholder="https://login.salesforce.com or your My Domain" /></label>
      </section>

      <section className="card">
        <h3>AI provider</h3>
        <label>Anthropic API key {s?.anthropicKey.set && <span className="badge ok">saved</span>}
          <input type="password" value={form.anthropicKey} onChange={set('anthropicKey')} placeholder={s?.anthropicKey.set ? '•••••••• (leave blank to keep)' : 'sk-ant-...'} />
        </label>
        <label>Workspace ID (only for keys not tied to a workspace)
          <input value={form.anthropicWorkspaceId} onChange={set('anthropicWorkspaceId')} placeholder="wrkspc_..." />
          <span className="muted small">Needed for "user" keys (sk-ant-usr-…). Find it in the Claude Console under Settings → Workspaces. Leave blank for workspace keys.</span>
        </label>
        <label>Reuse identical AI answers for (hours)
          <input value={form.aiCacheHours} onChange={set('aiCacheHours')} placeholder="24 (default)" />
          <span className="muted small">When a Classify, Extract or tool-less AI step gets exactly the same input again, the earlier answer is reused at no cost. Steps that read live Salesforce data are never reused. 0 turns this off.</span>
        </label>
        <label>Daily AI budget (USD)
          <input value={form.dailyBudgetUsd} onChange={set('dailyBudgetUsd')} placeholder="2 (default)" />
          <span className="muted small">AI steps stop once the workspace has spent this much in the last 24 hours. Enter "none" for no limit.</span>
        </label>
      </section>

      <button className="primary" onClick={save}>Save</button> <span className="muted">{msg}</span>
    </div>
  );
}
