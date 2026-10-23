import { BarChart3, BookOpen, Bot, TrendingUp, ChevronRight, PanelLeft, PanelTop, ChevronDown, Check, ChevronsUpDown, History, House, Inbox, LayoutDashboard, LogOut, Moon, Plus, Search, Settings as SettingsIcon, Sun, Users, Radar, ShieldCheck, Bookmark, LayoutGrid, Compass } from 'lucide-react';
import { parseVoiceCommand, VoiceCommand } from './components/Voice';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, isDemo, type Alert, type Draft, type Me, type Tenant, type WorkflowRow } from './api';
import { CommandPalette, Menu, Toaster, toast, type Command } from './components/ui';
import { ApprovalsPage } from './pages/Approvals';
import { HomePage } from './pages/Home';
import { InsightsPage } from './pages/Insights';
import { KnowledgePage } from './pages/Knowledge';
import { ImpactPage } from './pages/Impact';
import { DiscoverPage } from './pages/Discover';
import { TrustPage } from './pages/Trust';
import { MemoryPage } from './pages/Memory';
import { ContactPage } from './pages/Contact';
import { AdminConsole } from './pages/Admin';
import { LEGAL_PATHS, LegalPage } from './pages/Legal';
import { Ribbon, type RibbonPalette } from './components/Ribbon';
import { SETTINGS_SECTIONS, SettingsHub, type SettingsSection } from './pages/SettingsHub';
import { AlertsBell } from './components/AlertsBell';
import { LinkPrompt } from './components/PersonLink';
import { appTour, startTour, Tour, tourSeen, visitorTour } from './components/Tour';
import { LockedPage, PlanProvider, PlanTag, TrialBanner, UpgradePrompt, usePlanState } from './components/Plan';
import type { Feature } from '@crmagents/shared';
import { LogoMark } from './components/Logo';
import { AuthPage } from './pages/Auth';
import { RunsPage } from './pages/Runs';
import { WorkflowsPage } from './pages/Workflows';

const PAGE_FRESH_MS = 2 * 60_000;

type Tab = 'home' | 'discover' | 'trust' | 'memory' | 'admin' | 'impact' | 'insights' | 'dashboards' | 'agents' | 'approvals' | 'activity' | 'knowledge' | 'settings';

const NAV: { group?: string; items: { key: Tab; label: string; icon: ReactNode }[] }[] = [
  { items: [
    { key: 'home', label: 'Home', icon: <House size={17} /> },
    { key: 'approvals', label: 'Approvals', icon: <Inbox size={17} /> },
  ] },
  { group: 'Automate', items: [
    { key: 'discover', label: 'Discover', icon: <Radar size={17} /> },
    { key: 'agents', label: 'Agents', icon: <Bot size={17} /> },
    { key: 'activity', label: 'Activity', icon: <History size={17} /> },
    { key: 'knowledge', label: 'Knowledge', icon: <BookOpen size={17} /> },
  ] },
  { group: 'Analyze', items: [
    { key: 'impact', label: 'Impact', icon: <TrendingUp size={17} /> },
    { key: 'insights', label: 'Insights', icon: <BarChart3 size={17} /> },
    { key: 'dashboards', label: 'Dashboards', icon: <LayoutDashboard size={17} /> },
  ] },
];
// Top navigation: five entries, two of them small menus (Stripe-style), so the bar stays calm.
type TopEntry = { key: Tab; label: string } | { label: string; items: { key: Tab; label: string; desc: string; feature?: Feature }[] };
const TOP_NAV: TopEntry[] = [
  { key: 'home', label: 'Home' },
  { key: 'discover', label: 'Discover' },
  { label: 'Agents', items: [
    { key: 'agents', label: 'Agents', desc: 'Automations and assistants' },
    { key: 'activity', label: 'Activity', desc: 'Every run, step by step' },
    { key: 'knowledge', label: 'Knowledge', desc: 'Guides your agents answer from' },
  ] },
  { key: 'approvals', label: 'Approvals' },
  { label: 'Analytics', items: [
    { key: 'insights', label: 'Insights', desc: 'Your business at a glance', feature: 'insights' },
    { key: 'dashboards', label: 'Dashboards', desc: 'Built from a sentence', feature: 'insights' },
    { key: 'impact', label: 'Impact', desc: 'Time and money your agents saved', feature: 'impact' },
  ] },
];

// Each area has its own ribbon colours: you can tell where you are at a glance, without anything extra on screen.
const RIBBON: Record<Tab, RibbonPalette> = { admin: 'silver', trust: 'silver', memory: 'dusk', home: 'sunset', discover: 'ocean', agents: 'dusk', activity: 'dusk', knowledge: 'dusk', approvals: 'amber', insights: 'mint', dashboards: 'mint', impact: 'mint', settings: 'silver' };

const LABEL: Record<Tab, string> = { home: 'Home', discover: 'Discover', trust: 'Trust center', memory: 'Memory', admin: 'Super admin', approvals: 'Approvals', agents: 'Agents', activity: 'Activity', knowledge: 'Knowledge', impact: 'Impact', insights: 'Insights', dashboards: 'Dashboards', settings: 'Settings' };

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
  const planState = usePlanState(!!me);
  const { has } = planState;
  // Pages stay mounted once visited: switching back is instant (no reload flash) and keeps scroll position.
  // A page left alone for a couple of minutes reloads on return, so its numbers are fresh.
  const mainRef = useRef<HTMLElement>(null);
  const scrolls = useRef<Record<string, number>>({});
  const leftAt = useRef<Record<string, number>>({});
  const prevTab = useRef(tab);
  const [seen, setSeen] = useState<Set<string>>(() => new Set([tab]));
  const [paneKeys, setPaneKeys] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const prev = prevTab.current;
    if (prev !== tab) { leftAt.current[prev] = Date.now(); prevTab.current = tab; }
    const left = leftAt.current[tab];
    if (left && Date.now() - left > PAGE_FRESH_MS) { setPaneKeys((k) => ({ ...k, [tab]: (k[tab] ?? 0) + 1 })); scrolls.current[tab] = 0; }
    setSeen((x) => (x.has(tab) ? x : new Set(x).add(tab)));
    if (mainRef.current) mainRef.current.scrollTop = scrolls.current[tab] ?? 0;
  }, [tab]);
  const onMainScroll = (e: React.UIEvent<HTMLElement>) => { scrolls.current[tab] = e.currentTarget.scrollTop; };
  const pane = (key: Tab, node: ReactNode) => (seen.has(key) || tab === key) && (
    <div key={`${key}-${paneKeys[key] ?? 0}`} className={'tab-pane page-in' + (key === 'agents' ? ' fill' : '')} hidden={tab !== key}>{node}</div>
  );
  // Stripe-style top navigation by default; the sidebar is still there for people who prefer it.
  const [layout, setLayout] = useState<'top' | 'side'>(() => { try { return localStorage.getItem('layout') === 'side' ? 'side' : 'top'; } catch { return 'top'; } });
  const switchLayout = () => { const next = layout === 'top' ? 'side' : 'top'; setLayout(next); try { localStorage.setItem('layout', next); } catch { /* ignore */ } };
  const [cmdk, setCmdk] = useState(false);
  const [cmdkQuery, setCmdkQuery] = useState('');
  const [voiceAsk, setVoiceAsk] = useState<{ q: string; n: number }>();
  const [settingsAt, setSettingsAt] = useState<{ section: SettingsSection; connect?: boolean; n: number }>({ section: new URLSearchParams(location.search).has('billing') ? 'plan' : (SETTINGS_SECTIONS.find((x) => x === new URLSearchParams(location.search).get('section')) ?? 'orgs'), n: 0 }); // back from Stripe: the Plan page
  const openSettings = (section: SettingsSection = 'orgs', connect = false) => { setSettingsAt((s) => ({ section, connect, n: s.n + 1 })); setTab('settings'); };
  // Guided tours: visitors get the demo tour (?demo&tour=visitor); a new workspace (no org yet) gets a short welcome once.
  const tours = useMemo(() => {
    const first = (me?.email ?? '').split('@')[0].split(/[._]/)[0];
    return {
      visitor: visitorTour(() => { location.href = '/?signup'; }),
      welcome: appTour({ name: first ? first[0].toUpperCase() + first.slice(1) : '', connected: tenants.length > 0, connect: () => openSettings('orgs', true), newAgent: () => newAgent() }),
    };
  }, [me?.email, tenants.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const tourGo = (t: string, section?: string) => (section ? openSettings(section as SettingsSection) : setTab(t as Tab));
  const planValue = { ...planState, openPlans: () => openSettings('plan') };
  // An alert opens where it can be fixed: the org list for a disconnected org, else the agent's org and the Agents page.
  const openAlert = (a: Alert) => {
    if (a.tenantId && a.tenantId !== tenantId) setTenantId(a.tenantId);
    if (a.kind === 'disconnected') openSettings('orgs'); else setTab('agents');
  };
  const [agentList, setAgentList] = useState<WorkflowRow[]>([]);

  const reload = () =>
    api.tenants().then((t) => {
      setTenants(t);
      setTenantId((cur) => (t.some((x) => x.id === cur) ? cur : (t[0]?.id ?? '')));
      setTenantsLoaded(true);
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
    const linked = params.get('linked');
    if (linked) {
      setTenantId(linked);
      toast('Salesforce login linked: assistants now act as you');
      history.replaceState(null, '', '/');
    } else if (connected) {
      setTenantId(connected);
      setTab('settings');
      history.replaceState(null, '', '/');
    } else if (params.get('error')) {
      setTab('settings');
    }
    reload();
  }, [me?.id]);

  useEffect(() => { if (tenantId) try { localStorage.setItem('tenantId', tenantId); } catch { /* ignore */ } }, [tenantId]);
  const [tenantsLoaded, setTenantsLoaded] = useState(false);
  useEffect(() => {
    if (!me) return;
    if (isDemo()) { if (new URLSearchParams(location.search).get('tour') === 'visitor') setTimeout(() => startTour('visitor'), 900); return; }
    if (tenantsLoaded && tenants.length === 0 && !tourSeen('welcome')) setTimeout(() => startTour('welcome'), 900);
  }, [me?.id, tenantsLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

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

  // The Contact page is public, signed in or not.
  if (location.pathname === '/contact') return <ContactPage />;
  if (LEGAL_PATHS[location.pathname]) return <LegalPage doc={LEGAL_PATHS[location.pathname]} />;
  if (me === undefined) return <div className="pad muted">Loading…</div>;
  // An invitation or reset link opens the sign-in card even when someone is already signed in on this browser.
  const linkToken = /[?&](invite|reset)=/.test(location.search);
  if (me === null || linkToken) return <AuthPage onDone={() => { setMe(undefined); api.me().then(setMe).catch(() => setMe(null)); }} />;

  const logout = async () => { await api.logout(); setTenants([]); setTenantId(''); setMe(null); };
  const newAgent = (request?: string) => { setPrefill(request?.trim() || ' '); setTab('agents'); };
  const commands: Command[] = [
    ...(Object.keys(LABEL) as Tab[]).map((t) => ({ id: `go-${t}`, label: LABEL[t], group: 'Pages', run: () => setTab(t) })),
    { id: 'new-agent', label: 'New agent', hint: 'Build by chatting', group: 'Actions', run: () => newAgent() },
    { id: 'connect-org', label: 'Connect a Salesforce org', group: 'Actions', run: () => openSettings('orgs', true) },
    { id: 'theme', label: theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', group: 'Actions', run: toggleTheme },
    ...agentList.map((w) => ({ id: `a-${w.id}`, label: w.name, hint: w.live ? 'On' : 'Off', group: 'Agents', run: () => setTab('agents') })),
  ];
  // The top-bar microphone: navigate, start an agent, ask Insights, or search with what was said.
  const onVoice = (said: string) => {
    const v = parseVoiceCommand(said);
    if (v.kind === 'go') { if (v.section) openSettings(v.section); else setTab(v.tab); toast(`"${said}"`, 'info'); }
    else if (v.kind === 'new-agent') { newAgent(v.request ? said.replace(/^(hey |ok |okay )?nimbus[, ]*/i, '') : ''); toast(v.request ? 'Building that agent: answer its questions in the chat.' : 'New agent: describe what it should do.', 'info'); }
    else if (v.kind === 'ask') { if (!has('insights')) { setCmdkQuery(said); setCmdk(true); return; } setVoiceAsk((p) => ({ q: v.question, n: (p?.n ?? 0) + 1 })); setTab('insights'); }
    else if (v.kind === 'theme') { if (v.dark !== (theme === 'dark')) toggleTheme(); }
    else if (v.kind === 'tour') startTour(isDemo() ? 'visitor' : 'welcome');
    else { setCmdkQuery(v.text); setCmdk(true); }
  };
  const statusDot = tenant?.setup_status === 'ready' ? 'dot-ok' : tenant?.setup_status === 'error' ? 'dot-bad' : 'dot-warn';

  // The staff console has its own full-screen layout.
  if (tab === 'admin' && me.platformAdmin) return <PlanProvider value={planValue}><div className="app"><AdminConsole me={me} onExit={() => setTab('home')} /></div></PlanProvider>;

  if (layout === 'top') {
    return (
      <PlanProvider value={planValue}>
      <div className="app app-top">
        <header className="tnav">
          <div className="tnav-inner">
            <button className="tnav-brand" onClick={() => setTab('home')} aria-label="Nimbus home">
              <span className="brand-mark"><LogoMark size={14} /></span>Nimbus
            </button>
            <nav className="tnav-links" aria-label="Main">
              {TOP_NAV.map((it) => 'key' in it ? (
                <button key={it.key} className={'tnav-link' + (tab === it.key ? ' on' : '')} onClick={() => setTab(it.key)} aria-current={tab === it.key ? 'page' : undefined}>
                  {it.label}
                  {it.key === 'approvals' && waitingCount > 0 && <span className="count">{waitingCount}</span>}
                </button>
              ) : (
                <Menu key={it.label} className="nav-menu" trigger={(open) => {
                  const cur = it.items.find((x) => x.key === tab);
                  return (
                    <button className={'tnav-link' + (cur ? ' on' : '') + (open ? ' open' : '')} aria-haspopup="menu" aria-expanded={open}>
                      {it.label}<ChevronDown size={13} className="tnav-caret" />
                    </button>
                  );
                }}>
                  {(close) => it.items.map((x) => (
                    <button key={x.key} className={'mi nav-mi' + (tab === x.key ? ' on' : '')} onClick={() => { close(); setTab(x.key); }}>
                      <span><b>{x.label}{x.feature && <PlanTag feature={x.feature} />}</b><small>{x.desc}</small></span>
                    </button>
                  ))}
                </Menu>
              ))}
            </nav>
            <div className="tnav-right">
              <button className="ghost icon" onClick={() => setCmdk(true)} aria-label="Search (⌘K)" title="Search (⌘K)"><Search size={16} /></button>
              <VoiceCommand onCommand={onVoice} />
              <AlertsBell onOpen={openAlert} />
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
              <Menu align="right" className="acct-menu" trigger={() => (
                <button className="acct" title={me.email} aria-label="Account"><span className="ws-mark">{initials(me.accountName || me.email)}</span></button>
              )}>
                {(close) => (
                  <>
                    <div className="mh"><b>{me.accountName}</b>{me.email}</div>
                    <div className="msep" />
                    <button className="mi" onClick={() => { close(); setTab('settings'); }}><SettingsIcon size={15} /> Settings</button>
                    <button className="mi" onClick={() => { close(); openSettings('team'); }}><Users size={15} /> Team</button>
                    <button className="mi" onClick={() => { close(); setTab('memory'); }}><Bookmark size={15} /> Memory</button>
                    <button className="mi" onClick={() => { close(); startTour(isDemo() ? 'visitor' : 'welcome'); }}><Compass size={15} /> Take the tour</button>
                    {me.platformAdmin && <button className="mi" onClick={() => { close(); setTab('admin'); }}><LayoutGrid size={15} /> Super admin</button>}
                    <button className="mi" onClick={() => { close(); setTab('trust'); }}><ShieldCheck size={15} /> Trust center</button>
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
        <TrialBanner />
        <main ref={mainRef} onScroll={onMainScroll} className={'stripe-main' + (tab === 'agents' ? ' full' : '')}>
          {/* Silk ribbon behind the top of every page, like stripe.com's hero. */}
          <Ribbon className="app-ribbon" strands={260} angle={0.6} width={0.3} palette={RIBBON[tab] ?? 'sunset'} />
          {pane('home', <HomePage me={me} tenant={tenant} go={setTab} newAgent={newAgent} openSettings={openSettings} />)}
          {pane('impact', has('impact') ? <ImpactPage tenant={tenant} /> : <LockedPage feature="impact" title="Impact" />)}
          {pane('discover', <DiscoverPage tenant={tenant} openAgents={() => setTab('agents')} />)}
          {pane('trust', <TrustPage me={me} />)}
          {pane('memory', <MemoryPage me={me} tenants={tenants} />)}
          {pane('insights', !has('insights') ? <LockedPage feature="insights" title="Insights" /> : <InsightsPage key="ins" fixedView="overview" ask={voiceAsk} tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />)}
          {pane('dashboards', !has('insights') ? <LockedPage feature="insights" title="Dashboards" /> : <InsightsPage key="dash" fixedView="dashboards" tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />)}
          {pane('agents', <WorkflowsPage tenant={tenant} goConnections={() => setTab('settings')} incoming={incoming} onIncomingOpened={() => setIncoming(null)} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />)}
          {pane('approvals', <ApprovalsPage tenant={tenant} onChange={refreshWaiting} me={me.email} />)}
          {pane('knowledge', <KnowledgePage tenant={tenant} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />)}
          {pane('activity', <RunsPage tenant={tenant} goSettings={() => setTab('settings')} />)}
          {pane('settings', <SettingsHub key={settingsAt.n} section={settingsAt.section} focusConnect={settingsAt.connect} tenants={tenants} tenant={tenant} onChange={reload} me={me} openAdmin={me.platformAdmin ? () => setTab('admin') : undefined} />)}
        </main>
        <CommandPalette open={cmdk} initial={cmdkQuery} onClose={() => { setCmdk(false); setCmdkQuery(''); }} commands={commands} />
        <UpgradePrompt me={me} />
        <LinkPrompt tenants={tenants} />
        <Tour tours={tours} go={tourGo} />
        <Toaster />
      </div>
      </PlanProvider>
    );
  }

  return (
    <PlanProvider value={planValue}>
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
          <VoiceCommand onCommand={onVoice} />
          <div className="top-right">
            <AlertsBell onOpen={openAlert} />
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
        <TrialBanner />
        <main ref={mainRef} onScroll={onMainScroll} className={tab === 'agents' ? 'full' : ''}>
          {pane('home', <HomePage me={me} tenant={tenant} go={setTab} newAgent={newAgent} openSettings={openSettings} />)}
          {pane('impact', has('impact') ? <ImpactPage tenant={tenant} /> : <LockedPage feature="impact" title="Impact" />)}
          {pane('discover', <DiscoverPage tenant={tenant} openAgents={() => setTab('agents')} />)}
          {pane('trust', <TrustPage me={me} />)}
          {pane('memory', <MemoryPage me={me} tenants={tenants} />)}
          {pane('insights', !has('insights') ? <LockedPage feature="insights" title="Insights" /> : <InsightsPage key="ins" fixedView="overview" ask={voiceAsk} tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />)}
          {pane('dashboards', !has('insights') ? <LockedPage feature="insights" title="Dashboards" /> : <InsightsPage key="dash" fixedView="dashboards" tenant={tenant} goSettings={() => setTab('settings')} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />)}
          {pane('agents', <WorkflowsPage tenant={tenant} goConnections={() => setTab('settings')} incoming={incoming} onIncomingOpened={() => setIncoming(null)} prefill={prefill} onPrefillUsed={() => setPrefill(null)} />)}
          {pane('approvals', <ApprovalsPage tenant={tenant} onChange={refreshWaiting} me={me.email} />)}
          {pane('knowledge', <KnowledgePage tenant={tenant} onAutomate={(r) => { setPrefill(r); setTab('agents'); }} />)}
          {pane('activity', <RunsPage tenant={tenant} goSettings={() => setTab('settings')} />)}
          {pane('settings', <SettingsHub key={settingsAt.n} section={settingsAt.section} focusConnect={settingsAt.connect} tenants={tenants} tenant={tenant} onChange={reload} me={me} openAdmin={me.platformAdmin ? () => setTab('admin') : undefined} />)}
        </main>
      </div>
      <CommandPalette open={cmdk} initial={cmdkQuery} onClose={() => { setCmdk(false); setCmdkQuery(''); }} commands={commands} />
      <UpgradePrompt me={me} />
      <LinkPrompt tenants={tenants} />
      <Tour tours={tours} go={tourGo} />
      <Toaster />
    </div>
    </PlanProvider>
  );
}
