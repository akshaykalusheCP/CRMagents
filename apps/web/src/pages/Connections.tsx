import { useEffect, useState } from 'react';
import { api, type Settings, type Tenant } from '../api';

const needsReconnect = (t: Tenant) => t.setup_status === 'error' && /reconnect/i.test(t.setup_message ?? '');

const BUSY = new Set(['pending', 'installing', 'configuring']);
const STATUS_LABEL: Record<string, string> = {
  pending: 'Setting up…', installing: 'Installing…', configuring: 'Configuring…', ready: 'Ready', error: 'Needs attention',
};

export function ConnectionsPage({ tenants, onChange, goSettings }: { tenants: Tenant[]; onChange: () => void; goSettings: () => void }) {
  const [s, setS] = useState<Settings>();
  const [sandbox, setSandbox] = useState(false);
  const [domain, setDomain] = useState('');
  const [own, setOwn] = useState({ clientId: '', clientSecret: '' });
  const [ownErr, setOwnErr] = useState('');
  const error = new URLSearchParams(location.search).get('error');

  useEffect(() => { api.settings().then(setS).catch(() => {}); }, []);

  // Setup (package install etc.) runs in the background after connecting; poll while any org is busy.
  const busy = tenants.some((t) => BUSY.has(t.setup_status ?? ''));
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(onChange, 3000);
    return () => clearInterval(id);
  }, [busy, onChange]);

  const connectOwn = async () => {
    setOwnErr('');
    try {
      const { url } = await api.startOAuth({ sandbox, domain: domain.trim() || undefined, clientId: own.clientId, clientSecret: own.clientSecret || undefined });
      location.href = url;
    } catch (e) { setOwnErr((e as Error).message); }
  };

  const retry = async (id: string) => { await api.setup(id); onChange(); };
  const configured = !!s?.sfClientId;

  return (
    <div className="page narrow">
      <h2>Salesforce connections</h2>
      {!configured && (
        <div className="card warn">
          The Salesforce app is not configured. <button onClick={goSettings}>Open Settings</button>
        </div>
      )}
      {error && <div className="card warn">{error}</div>}

      <div className="card">
        <b>Connect a Salesforce org</b>
        <p className="muted small">
          Log in with your Salesforce username and password on Salesforce's own page. That's all: nothing is
          installed in your org.
        </p>
        <label>My Domain URL (optional)
          <input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="mycompany.my.salesforce.com" />
          <span className="muted small">Leave blank for login.salesforce.com.</span>
        </label>
        <label className="row"><input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> Sandbox org</label>
        <a className={'button primary' + (configured ? '' : ' disabled')} href={`/oauth/connect?${new URLSearchParams({ ...(sandbox ? { sandbox: '1' } : {}), ...(domain.trim() ? { domain: domain.trim() } : {}) })}`}>
          Connect Salesforce org
        </a>
      </div>

      {tenants.map((t) => {
        const st = t.setup_status ?? 'pending';
        return (
          <div className="card" key={t.id}>
            <div className="row between">
              <div>
                <b>{t.sf_username ?? t.sf_org_id}</b>
                <div className="muted small">{t.sf_instance_url}</div>
              </div>
              <span className={'badge ' + (st === 'ready' ? 'ok' : st === 'error' ? 'err' : '')}>{needsReconnect(t) ? 'Needs reconnect' : (STATUS_LABEL[st] ?? st)}</span>
            </div>
            {t.setup_message && <div className={'small ' + (st === 'error' ? 'err' : 'muted')}>{t.setup_message}</div>}
            <div className="row">
              {needsReconnect(t) && (
                // Opens this org's own login page; the new login replaces the revoked one.
                <a className="button primary" href={`/oauth/connect?${new URLSearchParams({ domain: new URL(t.sf_instance_url).hostname })}`}>Reconnect</a>
              )}
              <button onClick={() => retry(t.id)} disabled={BUSY.has(st)}>{st === 'error' ? 'Retry setup' : 'Re-run setup'}</button>
              {!t.use_package ? (
                <button className="ghost" onClick={async () => { if (confirm('Install the optional CRMagents panel in this org? It adds an "Agent Panel" you can put on record pages. Needs a Salesforce admin.')) { await api.setPackage(t.id, true); onChange(); } }} title="Optional: adds an agent panel to Salesforce record pages">
                  Add record-page panel (optional)
                </button>
              ) : <span className="badge">Record-page panel installed</span>}
              <button className="danger" onClick={async () => { if (confirm('Disconnect this org? Its workflows will be deleted.')) { await api.removeTenant(t.id); onChange(); } }}>Disconnect</button>
            </div>
          </div>
        );
      })}

      <details className="card">
        <summary><b>Advanced: use your own Salesforce app</b></summary>
        <p className="muted small">
          For security teams that require the login app to live in their own org. Most customers never need this.
        </p>
        <ol className="small">
          <li>In Salesforce: Setup → <b>External Client App Manager</b> → <b>New External Client App</b>.</li>
          <li>Enable OAuth. Callback URL: <code className="copy">{s?.callbackUrl}</code></li>
          <li>Scopes: <b>Manage user data via APIs (api)</b> and <b>Perform requests at any time (refresh_token)</b>.</li>
          <li>Turn on <b>PKCE</b> and turn off <b>Require secret for Web Server Flow</b> (or keep it and paste the secret below).</li>
          <li>Under Policies, set Permitted Users to <b>All users may self-authorize</b>. Save, then copy the <b>Consumer Key</b>.</li>
        </ol>
        <label>Consumer Key<input value={own.clientId} onChange={(e) => setOwn({ ...own, clientId: e.target.value })} placeholder="3MVG9..." /></label>
        <label>Consumer Secret (only if you kept secrets required)<input type="password" value={own.clientSecret} onChange={(e) => setOwn({ ...own, clientSecret: e.target.value })} /></label>
        {ownErr && <div className="err">{ownErr}</div>}
        <button className="primary" disabled={!own.clientId.trim()} onClick={connectOwn}>Connect with my app</button>
      </details>
    </div>
  );
}
