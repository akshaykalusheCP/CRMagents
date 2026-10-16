import { MoreHorizontal, Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Settings, type Tenant } from '../api';
import { Menu, Panel, Status, Table, type Column } from '../components/ui';

// Salesforce orgs: who is connected and in what state, how to connect another, and (rarely) your own login app.

const needsReconnect = (t: Tenant) => t.setup_status === 'error' && /reconnect/i.test(t.setup_message ?? '');
const BUSY = new Set(['pending', 'installing', 'configuring']);
const LABEL: Record<string, string> = { pending: 'Setting up', installing: 'Installing', configuring: 'Configuring', ready: 'Ready', error: 'Needs attention' };

export function ConnectionsPage({ tenants, onChange, goSettings }: { tenants: Tenant[]; onChange: () => void; goSettings: () => void }) {
  const [s, setS] = useState<Settings>();
  const [sandbox, setSandbox] = useState(false);
  const [domain, setDomain] = useState('');
  const [own, setOwn] = useState({ clientId: '', clientSecret: '' });
  const [ownErr, setOwnErr] = useState('');
  const [confirm, setConfirm] = useState<{ id: string; kind: 'disconnect' | 'panel' } | null>(null);
  const error = new URLSearchParams(location.search).get('error');

  useEffect(() => { api.settings().then(setS).catch(() => {}); }, []);
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
  const configured = !!s?.sfClientId;
  const connectHref = `/oauth/connect?${new URLSearchParams({ ...(sandbox ? { sandbox: '1' } : {}), ...(domain.trim() ? { domain: domain.trim() } : {}) })}`;

  const cols: Column<Tenant>[] = [
    { key: 'org', header: 'Org', render: (t) => <div className="cell-main"><b>{t.sf_username ?? t.sf_org_id}</b><span className="cell-sub">{t.sf_instance_url.replace(/^https:\/\//, '')}</span></div> },
    { key: 'status', header: 'Status', render: (t) => {
      const st = t.setup_status ?? 'pending';
      return <div className="cell-main">
        <Status tone={st === 'ready' ? 'ok' : st === 'error' ? 'bad' : 'warn'}>{needsReconnect(t) ? 'Needs reconnect' : LABEL[st] ?? st}</Status>
        {t.setup_message && st !== 'ready' && <span className="cell-sub">{t.setup_message}</span>}
      </div>;
    } },
    { key: 'panel', header: 'Record-page panel', hideSm: true, render: (t) => <span className="muted">{t.use_package ? 'Installed' : 'Not installed'}</span> },
    { key: 'x', header: '', align: 'right', render: (t) => (
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        {confirm?.id === t.id ? (
          <>
            <span className="muted small">{confirm.kind === 'disconnect' ? 'Disconnect and delete its agents?' : 'Install the optional panel? Needs a Salesforce admin.'}</span>
            <button className="sm" onClick={() => setConfirm(null)}>Cancel</button>
            <button className={'sm ' + (confirm.kind === 'disconnect' ? 'danger-solid' : 'primary')} onClick={async () => {
              setConfirm(null);
              if (confirm.kind === 'disconnect') await api.removeTenant(t.id); else await api.setPackage(t.id, true);
              onChange();
            }}>{confirm.kind === 'disconnect' ? 'Disconnect' : 'Install'}</button>
          </>
        ) : <>
          {needsReconnect(t) && <a className="button primary sm" href={`/oauth/connect?${new URLSearchParams({ domain: new URL(t.sf_instance_url).hostname })}`}>Reconnect</a>}
          <Menu align="right" trigger={() => <button className="ghost icon sm" aria-label="Org actions"><MoreHorizontal size={16} /></button>}>
            {(close) => <>
              <button className="mi" disabled={BUSY.has(t.setup_status ?? '')} onClick={async () => { close(); await api.setup(t.id); onChange(); }}>{t.setup_status === 'error' ? 'Retry setup' : 'Re-run setup'}</button>
              {!t.use_package && <button className="mi" onClick={() => { close(); setConfirm({ id: t.id, kind: 'panel' }); }}>Add record-page panel</button>}
              <div className="msep" />
              <button className="mi danger" onClick={() => { close(); setConfirm({ id: t.id, kind: 'disconnect' }); }}>Disconnect</button>
            </>}
          </Menu>
        </>}
      </div>
    ) },
  ];

  return (
    <div className="smart-col">
      {!configured && s && <div className="banner warn"><div><b>Salesforce login app not set</b><span>Add the app's Consumer Key under AI &amp; spending → Advanced before connecting orgs.</span></div><button className="sm" onClick={goSettings}>Open</button></div>}
      {error && <div className="banner bad"><div><b>Couldn't connect</b><span>{error}</span></div></div>}

      {tenants.length > 0 && <Panel flush title="Connected orgs"><Table columns={cols} rows={tenants} rowKey={(t) => t.id} /></Panel>}

      <Panel title={tenants.length ? 'Connect another org' : 'Connect your Salesforce org'}>
        <div className="form">
          <div className="frow">
            <div className="flabel"><b>Login</b><span>You log in on Salesforce's own page. Nothing is installed in your org.</span></div>
            <div className="ffield">
              <input id="sf-domain" value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="mycompany.my.salesforce.com (optional)" aria-label="My Domain URL" />
              <label className="check"><input type="checkbox" checked={sandbox} onChange={(e) => setSandbox(e.target.checked)} /> This is a sandbox</label>
              <a className={'button primary cta' + (configured ? '' : ' disabled')} href={connectHref} style={{ alignSelf: 'flex-start' }}><Plug size={15} /> Connect Salesforce</a>
            </div>
          </div>
        </div>
      </Panel>

      <details className="panel adv">
        <summary>Advanced: use your own Salesforce login app</summary>
        <div className="panel-body form">
          <p className="muted small" style={{ margin: 0 }}>For security teams that need the login app to live in their own org. Most customers never need this.</p>
          <ol className="small steps-ol">
            <li>In Salesforce: Setup → <b>External Client App Manager</b> → <b>New External Client App</b>.</li>
            <li>Enable OAuth. Callback URL: <code className="copy">{s?.callbackUrl}</code></li>
            <li>Scopes: <b>api</b> and <b>refresh_token</b>. Turn on <b>PKCE</b>.</li>
            <li>Policies: Permitted Users = <b>All users may self-authorize</b>. Save and copy the <b>Consumer Key</b>.</li>
          </ol>
          <div className="frow"><div className="flabel"><b>Consumer Key</b></div><div className="ffield"><input id="own-key" value={own.clientId} onChange={(e) => setOwn({ ...own, clientId: e.target.value })} placeholder="3MVG9..." /></div></div>
          <div className="frow"><div className="flabel"><b>Consumer Secret</b><span>Only if your app requires one.</span></div><div className="ffield"><input id="own-secret" type="password" value={own.clientSecret} onChange={(e) => setOwn({ ...own, clientSecret: e.target.value })} /></div></div>
          {ownErr && <div className="err">{ownErr}</div>}
          <button className="primary" style={{ alignSelf: 'flex-start' }} disabled={!own.clientId.trim()} onClick={connectOwn}>Connect with my app</button>
        </div>
      </details>
    </div>
  );
}
