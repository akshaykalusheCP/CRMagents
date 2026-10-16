import { BarChart3, BookOpen, Bot, ChevronRight, PanelLeft, PanelTop, Sparkles, Check, ChevronsUpDown, History, House, Inbox, LayoutDashboard, LogOut, Moon, Plus, Search, Settings as SettingsIcon, Sun } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, type Draft, type Me, type Tenant, type WorkflowRow } from './api';
import { CommandPalette, Menu, Toaster, type Command } from './components/ui';
import { ApprovalsPage } from './pages/Approvals';
import { HomePage } from './pages/Home';
import { InsightsPage } from './pages/Insights';
import { KnowledgePage } from './pages/Knowledge';
import { Ribbon } from './components/Ribbon';
import { SettingsHub } from './pages/SettingsHub';
import { AuthPage } from './pages/Auth';
import { RunsPage } from './pages/Runs';
import { WorkflowsPage } from './pages/Workflows';

type Tab = 'home' | 'insights' | 'dashboards' | 'agents' | 'approvals' | 'activity' | 'knowledge' | 'settings';

const NAV: { group?: string; items: { key: Tab; label: string; icon: ReactNode }[] }[] = [
  { items: [
    { key: 'home', label: 'Home', icon: <House size={17} /> },
    { key: 'approvals', label: 'Approvals', icon: <Inbox size={17} /> },
  ] },
  { group: 'Automate', items: [
    { key: 'agents', label: 'Agents', icon: <Bot size={17} /> },
    { key: 'activity', label: 'Activity', icon: <History size={17} /> },
    { key: 'knowledge', label: 'Knowledge', icon: <BookOpen size={17} /> },
  ] },
  { group: 'Analyze', items: [
    { key: 'insights', label: 'Insights', icon: <BarChart3 size={17} /> },
    { key: 'dashboards', label: 'Dashboards', icon: <LayoutDashboard size={17} /> },
  ] },
];
const LABEL: Record<Tab, string> = { home: 'Home', approvals: 'Approvals', agents: 'Agents', activity: 'Activity', knowledge: 'Knowledge', insights: 'Insights', dashboards: 'Dashboards', settings: 'Settings' };

function useTheme() {
  const initial = (): 'light' | 'dark' => {
    const saved = new URLSearchParams(location.search).get('theme') ?? (() => { try { return localStorage.getItem('theme'); } catch { return null; } })();
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
  const [tab, setTab] = useState<Tab>(() => (new URLSearchParams(location.search).get('tab') as Tab | null) ?? 'home'); // ?tab= deep link
  const [incoming, setIncoming] = useState<Draft | null>(null);
  const [prefill, setPrefill] = useState<string | null>(null);
  const [waitingCount, setWaitingCount] = useState(0);
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [tenantId, setTenantId] = useState<string>(() => { try { return localStorage.getItem('tenantId') ?? ''; } catch { return ''; } });
  const [theme, toggleTheme] = useTheme();
  // Stripe-style top navigation by default; the sidebar is still there for people who prefer it.
  const [layout, setLayout] = useState<'top' | 'side'>(() => { try { return localStorage.getItem('layout') === 'side' ? 'side' : 'top'; } catch { return 'top'; } });
  const switchLayout = () => { const next = layout === 'top' ? 'side' : 'top'; setLayout(next); try { localStorage.setItem('layout', next); } catch { /* ignore */ } };
  const [cmdk, setCmdk] = useState(false);
  const [settingsAt, setSettingsAt] = useState<{ section: 'orgs' | 'ai' | 'rules'; connect?: boolean; n: number }>({ section: 'orgs', n: 0 });
  const openSettings = (section: 'orgs' | 'ai' | 'rules' = 'orgs', connect = false) => { setSettingsAt((s) => ({ section, connect, n: s.n + 1 })); setTab('settings'); };
  const [agentList, setAgentList] = useState<WorkflowRow[]>([]);

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

  // ⌘K / Ctrl+K opens search; the agent list loads when it opens.
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk((o) => !o); } };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => { if (cmdk && tenantId) api.workflows(tenantId).then(setAgentList).catch(() => {}); }, [cmdk, tenantId]);

  if (me === undefined) return <div className="pad muted">Loading…</div>;
  if (me === null) return <AuthPage onDone={() => api.me().then(setMe)} />;

  const logout = async () => { await api.logout(); setTenants([]); setTenantId(''); setMe(null); };
  const newAgent = (request?: string) => { setPrefill(request?.trim() || ' '); setTab('agents'); };
  const commands: Command[] = [
    ...(Object.keys(LABEL) as Tab[]).map((t) => ({ id: `go-${t}`, label: LABEL[t], group: 'Pages', run: () => setTab(t) })),
    { id: 'new-agent', label: 'New agent', hint: 'Build by chatting', group: 'Actions', run: () => newAgent() },
    { id: 'connect-org', label: 'Connect a Salesforce org', group: 'Actions', run: () => openSettings('orgs', true) },
    { id: 'theme', label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', group: 'Actions', run: toggleTheme },
    ...agentList.map((w) => ({ id: `a-${w.id}`, label: w.name, hint: w.live ? 'On' : 'Off', group: 'Agents', run: () => setTab('agents') })),
  ];
  const statusDot = tenant?.setup_status === 'ready' ? 'dot-ok' : tenant?.setup_status === 'error' ? 'dot-bad' : 'dot-warn';

  if (layout === 'top') {
    const items = NAV.flatMap((g) => g.items);
    return (
      <div className="app app-top">
        <header className="tnav">
          <div className="tnav-inner">
            <button className="tnav-brand" onClick={() => setTab('home')} aria-label="CRMagents home">
              <span className="brand-mark"><Sparkles size={15} /></span>CRMagents
            </button>
            <nav className="tnav-links" aria-label="Main">
              {items.map((it) => (
                <button key={it.key} className={'tnav-link' + (tab === it.key ? ' on' : '')} onClick={() => setTab(it.key)} aria-current={tab === it.key ? 'page' : undefined}>
                  {it.label}
                  {it.key === 'approvals' && waitingCount > 0 && <span className="count">{waitingCount}</span>}
                </button>
              ))}
            </nav>
            <div className="tnav-right">
              <button className="ghost icon" onClick={() => setCmdk(true)} aria-label="Search (⌘K)" title="Search (⌘K)"><Search size={16} /></button>
              <button className={'ghost icon' + (tab === 'settings' ? ' on' : '')} onClick={() => setTab('settings')} aria-label="Settings" title="Settings"><SettingsIcon size={16} /></button>
            {tenants.length > 0 ? (
                <Menu align="right" trigger={() => (
                  <button className="org-btn" title="Salesforce org">
                    <i className={statusDot} /><span className="n">{tenant?.sf_username ?? tenant?.sf_org_id ?? 'Choose an org'}</span><ChevronsUpDown size={14} />
                  </button>
                )}>
                  {(close) => (
                    <>
                      <div className="mh">Salesforce orgs</div>
                      {tenants.map((t) => (
                        <button key={t.id} className="mi" onClick={() => { setTenantId(t.id); close(); }}>
                          <i className={t.setup_status === 'ready' ? 'dot-ok' : t.setup_status === 'error' ? 'dot-bad' : 'dot-warn'} />
                          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.sf_username ?? t.sf_org_id}</span>
                          {t.id === tenantId && <Check size={15} className="check" />}
                        </button>
                      ))}
                      <div className="msep" />
                      <button className="mi" onClick={() => { close(); openSettings('orgs', true); }}><Plus size={15} /> Connect another org</button>
                    </>
                  )}
                </Menu>
              ) : (
                <button className="primary sm" onClick={() => openSettings('orgs', true)}>Connect Salesforce</button>
              )}
              <button className="primary tnav-cta" onClick={() => newAgent()}>New agent <ChevronRight size={14} /></button>
              <Menu align="right" className="acct-menu" trigger={() => (
                <button className="acct" title={me.email} aria-label="Account"><span className="ws-mark">{initials(me.accountName || me.email)}</span></button>
              )}>
                {(close) => (
                  <>
                    <div className="mh"><b>{me.accountName}</b>{me.email}</div>
                    <div className="msep" />
                    <button className="mi" onClick={() => { close(); setTab('settings'); }}><SettingsIcon size={15} /> Settings</button>
                    <button className="mi" onClick={() => { close(); toggleTheme(); }}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />} {theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
                    <button className="mi" onClick={() => { close(); switchLayout(); }}><PanelLeft size={15} /> Navigation on the side</button>
                    <div className="msep" />
                    <button className="mi danger" onClick={() => { close(); void logout(); }}><LogOut size={15} /> Log out</button>
                  </>
                )}
              </Menu>
            </div>
          </div>
        </header>
        <main className={'stripe-main' + (tab === 'agents' ? ' full' : '')}>
          {/* Silk ribbon behind the top of every page, like stripe.com's hero. */}
          <Ribbon className="app-ribbon" strands={260} angle={0.6} width={0.3} />
          {tab === 'home' && <HomePage me={me} tenant={tenant} go={setTab} newAgent={newAgent} />}
          {tab === 'insights' && <InsightsPage key="ins" fixedView="overview" tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />}
          {tab === 'dashboards' && <InsightsPage key="dash" fixedView="dashboards" tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />}
          {tab === 'agents' && <WorkflowsPage tenant={tenant} goConnections={() => setTab('settings')} incoming={incoming} onIncomingOpened={() => setIncoming(null)} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />}
          {tab === 'approvals' && <ApprovalsPage tenant={tenant} onChange={refreshWaiting} me={me.email} />}
          {tab === 'knowledge' && <KnowledgePage tenant={tenant} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />}
          {tab === 'activity' && <RunsPage tenant={tenant} goSettings={() => setTab('settings')} />}
          {tab === 'settings' && <SettingsHub key={settingsAt.n} section={settingsAt.section} focusConnect={settingsAt.connect} tenants={tenants} tenant={tenant} onChange={reload} />}
        </main>
        <CommandPalette open={cmdk} onClose={() => setCmdk(false)} commands={commands} />
        <Toaster />
      </div>
    );
  }

  return (
    <div className="app">
      <aside className="side" aria-label="Main">
        <Menu className="ws-menu" trigger={() => (
          <button className="ws" title="Workspace">
            <span className="ws-mark">{initials(me.accountName || me.email)}</span>
            <span className="ws-name">{me.accountName || 'Workspace'}</span>
            <ChevronsUpDown size={15} />
          </button>
        )}>
          {(close) => (
            <>
              <div className="mh"><b>{me.accountName}</b>{me.email}</div>
              <div className="msep" />
              <button className="mi" onClick={() => { close(); setTab('settings'); }}><SettingsIcon size={15} /> Settings</button>
              <button className="mi" onClick={() => { close(); toggleTheme(); }}>{theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />} {theme === 'dark' ? 'Light mode' : 'Dark mode'}</button>
              <button className="mi" onClick={() => { close(); switchLayout(); }}><PanelTop size={15} /> Navigation on top</button>
              <div className="msep" />
              <button className="mi danger" onClick={() => { close(); void logout(); }}><LogOut size={15} /> Log out</button>
            </>
          )}
        </Menu>

        {NAV.map((g, gi) => (
          <div key={gi} style={{ display: 'contents' }}>
            {g.group && <div className="side-group">{g.group}</div>}
            {g.items.map((it) => (
              <button key={it.key} className={'nav2' + (tab === it.key ? ' on' : '')} onClick={() => setTab(it.key)} aria-current={tab === it.key ? 'page' : undefined}>
                {it.icon}<span>{it.label}</span>
                {it.key === 'approvals' && waitingCount > 0 && <span className="count">{waitingCount}</span>}
              </button>
            ))}
          </div>
        ))}

        <div className="side-foot">
          <button className={'nav2' + (tab === 'settings' ? ' on' : '')} onClick={() => setTab('settings')}><SettingsIcon size={17} /><span>Settings</span></button>
        </div>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <button className="search-btn" onClick={() => setCmdk(true)} aria-label="Search"><Search size={15} /><span>Search</span><kbd>⌘K</kbd></button>
          <div className="top-right">
            {tenants.length > 0 ? (
              <Menu align="right" trigger={() => (
                <button className="org-btn" title="Salesforce org">
                  <i className={statusDot} /><span className="n">{tenant?.sf_username ?? tenant?.sf_org_id ?? 'Choose an org'}</span><ChevronsUpDown size={14} />
                </button>
              )}>
                {(close) => (
                  <>
                    <div className="mh">Salesforce orgs</div>
                    {tenants.map((t) => (
                      <button key={t.id} className="mi" onClick={() => { setTenantId(t.id); close(); }}>
                        <i className={t.setup_status === 'ready' ? 'dot-ok' : t.setup_status === 'error' ? 'dot-bad' : 'dot-warn'} />
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.sf_username ?? t.sf_org_id}</span>
                        {t.id === tenantId && <Check size={15} className="check" />}
                      </button>
                    ))}
                    <div className="msep" />
                    <button className="mi" onClick={() => { close(); openSettings('orgs', true); }}><Plus size={15} /> Connect another org</button>
                  </>
                )}
              </Menu>
            ) : (
              <button className="primary sm" onClick={() => openSettings('orgs', true)}>Connect Salesforce</button>
            )}
            <button className="ghost icon" onClick={toggleTheme} title={theme === 'dark' ? 'Light mode' : 'Dark mode'}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
          </div>
        </header>

        <main className={tab === 'agents' ? 'full' : ''}>
          {tab === 'home' && <HomePage me={me} tenant={tenant} go={setTab} newAgent={newAgent} />}
          {tab === 'insights' && <InsightsPage key="ins" fixedView="overview" tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />}
          {tab === 'dashboards' && <InsightsPage key="dash" fixedView="dashboards" tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />}
          {tab === 'agents' && <WorkflowsPage tenant={tenant} goConnections={() => setTab('settings')} incoming={incoming} onIncomingOpened={() => setIncoming(null)} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />}
          {tab === 'approvals' && <ApprovalsPage tenant={tenant} onChange={refreshWaiting} me={me.email} />}
          {tab === 'knowledge' && <KnowledgePage tenant={tenant} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />}
          {tab === 'activity' && <RunsPage tenant={tenant} goSettings={() => setTab('settings')} />}
          {tab === 'settings' && <SettingsHub key={settingsAt.n} section={settingsAt.section} focusConnect={settingsAt.connect} tenants={tenants} tenant={tenant} onChange={reload} />}
        </main>
      </div>
      <CommandPalette open={cmdk} onClose={() => setCmdk(false)} commands={commands} />
      <Toaster />
    </div>
  );
}
