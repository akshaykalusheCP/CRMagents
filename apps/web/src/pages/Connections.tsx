import { ExternalLink, Loader2, MoreHorizontal, Plug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Settings, type Tenant } from '../api';
import { RecordPagePicker, UtilityBarPicker } from '../components/PagePlacement';
import { Drawer, Menu, Panel, Status, Table, toast, type Column, Meter } from '../components/ui';

// Salesforce orgs: who is connected and in what state, how to connect another, and (rarely) your own login app.

const needsReconnect = (t: Tenant) => t.setup_status === 'error' && /reconnect/i.test(t.setup_message ?? '');
const BUSY = new Set(['pending', 'installing', 'configuring']);
const LABEL: Record<string, string> = { pending: 'Setting up', installing: 'Installing', configuring: 'Configuring', ready: 'Ready', error: 'Needs attention' };

export function ConnectionsPage({ tenants, onChange, goSettings, focusConnect }: { tenants: Tenant[]; onChange: () => void; goSettings: () => void; focusConnect?: boolean }) {
  const [s, setS] = useState<Settings>();
  const [sandbox, setSandbox] = useState(false);
  const [domain, setDomain] = useState('');
  const [own, setOwn] = useState({ clientId: '', clientSecret: '' });
  const [ownErr, setOwnErr] = useState('');
  const [confirm, setConfirm] = useState<{ id: string; kind: 'disconnect' | 'panel' } | null>(null);
  const [guide, setGuide] = useState<Tenant | null>(null);
  const [granting, setGranting] = useState(false);
  const error = new URLSearchParams(location.search).get('error');

  useEffect(() => { api.settings().then(setS).catch(() => {}); }, []);
  const toConnect = () => {
    const el = document.getElementById('connect-org');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el?.classList.add('flash');
    setTimeout(() => el?.classList.remove('flash'), 1600);
    document.getElementById('sf-domain')?.focus({ preventScroll: true });
  };
  useEffect(() => { if (focusConnect) setTimeout(toConnect, 150); }, [focusConnect]);
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
    { key: 'api', header: 'API use (24h)', hideSm: true, render: (t) => <ApiUse t={t} /> },
    { key: 'panel', header: 'In Salesforce', render: (t) => {
      const st = t.setup_status ?? 'pending';
      if (t.use_package && BUSY.has(st)) return <span className="row muted small" style={{ gap: 6 }}><Loader2 size={14} className="spin" /> Installing…</span>;
      if (t.use_package && st === 'ready') return <button className="link-btn" onClick={() => setGuide(t)}>Installed · set up <ExternalLink size={13} /></button>;
      return <button className="sm primary" onClick={() => setConfirm({ id: t.id, kind: 'panel' })}>Install in Salesforce</button>;
    } },
    { key: 'x', header: '', align: 'right', render: (t) => (
      <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
        {confirm?.id === t.id ? (
          <>
            <span className="muted small">{confirm.kind === 'disconnect' ? 'Disconnect and delete its agents?' : 'Install CRMagents in this org? Takes 2–4 minutes; needs a Salesforce admin.'}</span>
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
              {t.use_package && <button className="mi" onClick={() => { close(); setGuide(t); }}>Set up in Salesforce</button>}
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

      {tenants.length > 0 && <Panel flush title="Connected orgs" action={<button className="sm" onClick={toConnect}><Plug size={14} /> Connect another org</button>}><Table columns={cols} rows={tenants} rowKey={(t) => t.id} /></Panel>}

      <Panel className="connect-panel" id="connect-org" title={tenants.length ? 'Connect another org' : 'Connect your Salesforce org'}>
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

      <Drawer open={!!guide} onClose={() => setGuide(null)} title="Use CRMagents inside Salesforce" sub={guide && <span>{guide.sf_username} · installed</span>}>
        {guide && (() => {
          const base = guide.sf_instance_url.replace(/\/$/, '');
          const link = (path: string, label: string) => <a className="link-btn" href={`${base}${path}`} target="_blank" rel="noreferrer">{label} <ExternalLink size={13} /></a>;
          return (
            <ol className="guide">
              <li><b>Give people access</b><span>Everyone who should use agents in Salesforce needs the "CRMagents User" permission set.</span>
                <div className="row" style={{ gap: 10 }}>
                  <button className="sm primary" disabled={granting} onClick={async () => { setGranting(true); try { const r = await api.grantAccess(guide.id); toast(`Access given to ${r.granted} more user${r.granted === 1 ? '' : 's'} (${r.total} active)`); } catch (e) { toast((e as Error).message, 'bad'); } finally { setGranting(false); } }}>{granting ? <Loader2 size={14} className="spin" /> : null} Give everyone access</button>
                  {link('/lightning/setup/PermSets/home', 'Or choose people')}
                </div></li>
              <li><b>Put the assistant in the utility bar</b><span>One click away on every page of the app: agents, an assistant to ask, and approvals.</span><UtilityBarPicker tenant={guide} /></li>
              <li><b>Add CRMagents to record pages</b><span>The Suggestions card (agent advice and what agents changed) and the Agent Panel, at the top of the side column. Pick an existing page, or get a new one to activate.</span><RecordPagePicker tenant={guide} /></li>
              <li><b>Add the "Ask CRMagents" button</b><span>Ready for Accounts, Cases, Contacts, Leads and Opportunities. In Object Manager → the object → Page Layouts → Mobile &amp; Lightning Actions, drag in <i>Ask CRMagents</i>.</span>{link('/lightning/setup/ObjectManager/Case/PageLayouts/view', 'Open Case page layouts')}</li>
              <li><b>Use agents in your Flows</b><span>In Flow Builder add an Action and search "CRMagents": <i>Run CRMagents agent</i> (by name) and <i>Ask CRMagents assistant</i> (returns the answer, e.g. to save a case summary).</span>{link('/builder_platform_interaction/flowBuilder.app', 'Open Flow Builder')}</li>
              <li><b>Approvals come to Salesforce</b><span>When an agent waits for approval, the approver gets a Salesforce notification (the bell) that opens the record. Nothing to set up.</span></li>
            </ol>
          );
        })()}
      </Drawer>

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

/**
 * The org's daily API allowance as Salesforce last reported it. It is shared with the customer's other
 * integrations, so CRMagents slows down at 50%, pauses optional work at 80% and keeps only essentials at 95%.
 */
function ApiUse({ t }: { t: Tenant }) {
  if (!t.api_max || t.api_used == null) return <span className="cell-sub">Not measured yet</span>;
  const pct = Math.round((t.api_used / t.api_max) * 100);
  const note = pct >= 95 ? 'Only approvals and changes continue'
    : pct >= 80 ? 'Dashboards and insights paused'
    : pct >= 50 ? 'Checking for records less often'
    : 'Plenty left';
  return (
    <div className="cell-main api-use" title={`CRMagents gives way as usage rises: slower record checks at 50%, optional work paused at 80%, only approvals and changes at 95%. Reported ${t.api_checked_at ? new Date(t.api_checked_at).toLocaleTimeString() : ''}.`}>
      <span><b>{pct}%</b> <span className="cell-sub">{t.api_used.toLocaleString()} of {t.api_max.toLocaleString()}</span></span>
      <Meter value={t.api_used} max={t.api_max} label="API use" />
      <span className={'cell-sub' + (pct >= 80 ? ' api-warn' : '')}>{note}</span>
    </div>
  );
}
