import { BarChart3, Bot, History, House, Inbox, LogOut, Moon, Plug, Settings as SettingsIcon, Sparkles, Sun } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type Draft, type Me, type Tenant } from './api';
import { ApprovalsPage } from './pages/Approvals';
import { HomePage } from './pages/Home';
import { InsightsPage } from './pages/Insights';
import { SettingsHub } from './pages/SettingsHub';
import { AuthPage } from './pages/Auth';
import { RunsPage } from './pages/Runs';
import { WorkflowsPage } from './pages/Workflows';

type Tab = 'home' | 'insights' | 'agents' | 'approvals' | 'activity' | 'settings';

const NAV: { key: Tab; label: string; icon: ReactNode }[] = [
  { key: 'home', label: 'Home', icon: <House size={18} /> },
  { key: 'insights', label: 'Insights', icon: <BarChart3 size={18} /> },
  { key: 'agents', label: 'Agents', icon: <Bot size={18} /> },
  { key: 'approvals', label: 'Approvals', icon: <Inbox size={18} /> },
  { key: 'activity', label: 'Activity', icon: <History size={18} /> },
  { key: 'settings', label: 'Settings', icon: <SettingsIcon size={18} /> },
];

function useTheme() {
  const initial = (): 'light' | 'dark' => {
    const saved = (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
    if (saved === 'light' || saved === 'dark') return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  };
  const [theme, setTheme] = useState<'light' | 'dark'>(initial);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch { /* private mode */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
}

const initials = (s: string) => s.split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = checking
  const [tab, setTab] = useState<Tab>('home');
  const [incoming, setIncoming] = useState<Draft | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [waitingCount, setWaitingCount] = useState(0);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>(() => { try { return localStorage.getItem('tenantId') ?? ''; } catch { return ''; } });
  const [theme, toggleTheme] = useTheme();

  const reload = () =>
    api.tenants().then((t) => {
      setTenants(t);
      setTenantId((cur) => (t.some((x) => x.id === cur) ? cur : (t[0]?.id ?? '')));
    }).catch(() => {});

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe(null));
    const onUnauth = () => setMe(null);
    window.addEventListener('crmagents:unauthorized', onUnauth);
    return () => window.removeEventListener('crmagents:unauthorized', onUnauth);
  }, []);

  useEffect(() => {
    if (!me) return;
    const params = new URLSearchParams(location.search);
    const connected = params.get('connected');
    if (connected) {
      setTenantId(connected);
      setTab('settings');
      history.replaceState(null, '', '/');
    } else if (params.get('error')) {
      setTab('settings');
    }
    reload();
  }, [me?.id]);

  useEffect(() => { if (tenantId) try { localStorage.setItem('tenantId', tenantId); } catch { /* ignore */ } }, [tenantId]);

  const tenant = tenants.find((t) => t.id === tenantId);

  // Approvals badge in the menu, refreshed every 30 s.
  const refreshWaiting = () => { if (tenantId) api.runs(tenantId, 'waiting').then((r) => setWaitingCount(r.length)).catch(() => {}); };
  useEffect(() => {
    refreshWaiting();
    const t = setInterval(refreshWaiting, 30_000);
    return () => clearInterval(t);
  }, [tenantId]);

  if (me === undefined) return <div className="pad muted">Loading…</div>;
  if (me === null) return <AuthPage onDone={() => api.me().then(setMe)} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark"><Sparkles size={16} /></span>
          <span><b>CRM</b>agents</span>
        </div>

        {NAV.map((it) => (
          <button key={it.key} className={'nav' + (tab === it.key ? ' active' : '')} onClick={() => setTab(it.key)}>
            {it.icon}<span>{it.label}</span>
            {it.key === 'approvals' && waitingCount > 0 && <span className="count">{waitingCount}</span>}
          </button>
        ))}

        <div className="spacer" />

        {tenants.length > 0 ? (
          <div className="org-switch">
            <div className="org-label">
              Salesforce org
              <span className={'dot ' + (tenant?.setup_status === 'ready' ? 'ok' : tenant?.setup_status === 'error' ? 'error' : 'waiting')} title={tenant?.setup_status} />
            </div>
            <select value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {tenants.map((t) => <option key={t.id} value={t.id}>{t.sf_username ?? t.sf_org_id}</option>)}
            </select>
          </div>
        ) : (
          <button className="nav" onClick={() => setTab('settings')}><Plug size={16} /><span>Connect Salesforce</span></button>
        )}

        <div className="user-row">
          <span className="avatar">{initials(me.accountName || me.email)}</span>
          <div className="who">
            <b>{me.accountName}</b>
            <span>{me.email}</span>
          </div>
          <button className="ghost icon" onClick={toggleTheme} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
          <button className="ghost icon" title="Log out" onClick={async () => { await api.logout(); setTenants([]); setTenantId(''); setMe(null); }}>
            <LogOut size={15} />
          </button>
        </div>
      </aside>

      <main className={tab === 'agents' ? 'full' : ''}>
        {tab === 'home' && <HomePage me={me} tenant={tenant} go={setTab} openDraft={(d) => { setIncoming(d); setTab('agents'); }} />}
        {tab === 'insights' && <InsightsPage tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />}
        {tab === 'agents' && <WorkflowsPage tenant={tenant} goConnections={() => setTab('settings')} incoming={incoming} onIncomingOpened={() => setIncoming(null)} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />}
        {tab === 'approvals' && <ApprovalsPage tenant={tenant} onChange={refreshWaiting} />}
        {tab === 'activity' && <RunsPage tenant={tenant} />}
        {tab === 'settings' && <SettingsHub tenants={tenants} onChange={reload} />}
      </main>
    </div>
  );
}
