import fx from './fixtures.json';

// Demo mode (/?demo): the real UI on captured data, no login or Salesforce needed. Used for screenshots and sales demos.
// Refresh the data with apps/api/scripts/capture-demo.mts.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function route(method: string, url: URL, body: any): Response {
  const p = url.pathname.replace(/^\/api\/tenants\/[^/]+/, '/t');
  // The staff console is not part of the public demo (?demo&staff shows it, for screenshots).
  if (p === '/api/auth/me') return json({ id: 'demo', email: 'owner@demo-company.com', accountName: 'Demo Company', role: 'owner', platformAdmin: new URLSearchParams(location.search).has('staff') });
  // Anything that would leave the demo (payments, Slack, linking a Salesforce login) says so instead.
  if (p === '/api/billing/checkout' || p === '/api/billing/portal' || p === '/api/chat-approvals/slack/install' || p === '/t/my-salesforce/link') return json({ error: DEMO_ONLY }, 400);
  if (p === '/api/tenants') return json([{ ...fx.tenant, api_used: 18240, api_max: 115000, api_checked_at: new Date().toISOString(), api_own_24h: 4310, api_cap: null }]);
  if (/^\/t\/api-cap$/.test(p)) return json({ error: DEMO_ONLY }, 400);
  if (p === '/api/plan') {
    // ?demo&plan=basic shows a Basic trial (locked pages, trial banner); otherwise everything is included.
    const basic = new URLSearchParams(location.search).get('plan') === 'basic';
    return json(basic
      ? { plan: 'basic', name: 'Basic', trialEndsAt: new Date(Date.now() + 9 * 86_400_000).toISOString(), trialEnded: false, requestedPlan: null, features: [], limits: { orgs: 1, users: 3, liveAgents: 3, assistants: 2 }, usage: { orgs: 1, users: 2, liveAgents: 2, assistants: 1 } }
      : { plan: 'promax', name: 'Pro Max', trialEndsAt: null, trialEnded: false, requestedPlan: null, features: ['panel', 'knowledge', 'emailReplies', 'insights', 'tests', 'memory', 'costCaps', 'websiteChat', 'textMessages', 'meetings', 'prove', 'xray', 'impact', 'trustLog'], limits: { orgs: null, users: null, liveAgents: null, assistants: null }, usage: { orgs: 1, users: 4, liveAgents: 3, assistants: 2 } });
  }
  if (p === '/api/plan/request') return json({ ok: true });
  if (p === '/api/billing') return json({ configured: false, intervals: { plus: { month: false, year: false }, pro: { month: false, year: false } }, subscription: null });
  if (p === '/api/platform/overview') return json(DEMO_ADMIN.overview);
  if (p === '/api/platform/accounts') return json(DEMO_ADMIN.accounts);
  if (/^\/api\/platform\/accounts\/[^/]+$/.test(p)) {
    const a = DEMO_ADMIN.accounts.find((x) => p.endsWith(x.id)) ?? DEMO_ADMIN.accounts[1];
    return json({ ...DEMO_ADMIN.detail, account: a });
  }
  if (/^\/api\/platform\/accounts\/[^/]+\/(meta|notes|trial|plan)$/.test(p) || /^\/api\/platform\/(notes|requests)\/[^/]+$/.test(p)) return json({ ok: true });
  if (p === '/api/platform/revenue') return json(DEMO_ADMIN.revenue);
  if (p === '/api/platform/integrations') return json({ stripe: false, slack: false });
  if (p === '/api/chat-approvals') return json({ slack: { available: true, connected: true, team: 'Demo Company', channel: '#approvals', by: 'owner@demo-company.com' }, teams: { connected: false, by: null } });
  if (p === '/api/chat-approvals/test') return json({ ok: true });
  if (p === '/api/ai-keys' && method === 'GET') return json({ platformDefault: false, keys: [
    { id: 'demo-key-1', label: 'Claude · production', provider: 'anthropic', hint: 'sk-ant-api03-…7Q2c', baseUrl: null, model: null, fastModel: null, priceIn: null, priceOut: null, workspaceId: null, primary: true, backup: false, sort: 0, lastTest: { at: new Date(Date.now() - 36e5).toISOString(), ok: true, ms: 612, model: 'claude-haiku-5-5' }, lastError: null, lastUsedAt: new Date(Date.now() - 6e5).toISOString(), createdAt: '2026-09-01T10:00:00Z' },
    { id: 'demo-key-2', label: 'OpenAI · backup', provider: 'openai', hint: 'sk-proj-…k9Fa', baseUrl: null, model: 'gpt-5', fastModel: 'gpt-5-mini', priceIn: 1.25, priceOut: 10, workspaceId: null, primary: false, backup: true, sort: 1, lastTest: { at: new Date(Date.now() - 864e5).toISOString(), ok: true, ms: 840, model: 'gpt-5' }, lastError: null, lastUsedAt: null, createdAt: '2026-09-12T10:00:00Z' },
  ] });
  if (/^\/api\/ai-keys\/(test|[^/]+\/test)$/.test(p)) return json({ ok: true, ms: 540, model: 'claude-haiku-5-5', reply: 'OK' });
  if (p.startsWith('/api/ai-keys')) return json({ error: DEMO_ONLY }, 400);
  if (p === '/api/platform/email') return json(method === 'GET' ? { configured: false, from: 'Nimbus <noreply@crmagents.app>', keyHint: null } : { ok: true });
  if (p === '/api/platform/email/test') return json({ ok: false, error: 'No Resend key set' });
  if (p === '/api/platform/staff') return json(['owner@demo-company.com', 'sales@crmagents.example']);
  if (p === '/api/platform/staff-log') return json(DEMO_ADMIN.log);
  if (p === '/api/platform/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    return json({ workspaces: DEMO_ADMIN.accounts.filter((a) => a.name.toLowerCase().includes(q) || a.owner.includes(q)).map((a) => ({ id: a.id, name: a.name, plan: a.plan, owner: a.owner })),
      users: DEMO_ADMIN.users.filter((u) => u.email.includes(q)).map((u) => ({ email: u.email, role: u.role, accountId: u.accountId, accountName: u.accountName })) });
  }
  if (p === '/api/platform/users') return json(DEMO_ADMIN.users);
  if (p === '/api/platform/payments') return json(DEMO_ADMIN.payments);
  if (p === '/api/platform/requests') return json(DEMO_ADMIN.requests);
  // ?demo&fresh: a brand-new workspace (no agents, no runs, no sample data yet) to show the guided first run.
  const fresh = new URLSearchParams(location.search).has('fresh');
  if (fresh && ((p === '/t/workflows' || p === '/t/runs' || p === '/t/suggestions') && method === 'GET')) return json([]);
  if (fresh && p === '/t/sample-data' && method === 'GET') return json({ loaded: false, counts: {}, loadedAt: null, allowed: true, orgKind: 'Developer Edition' });
  if (p === '/t/sample-data') return json(method === 'GET'
    ? { loaded: true, counts: { Account: 8, Contact: 12, Opportunity: 12, Case: 16, Lead: 10, Task: 5 }, loadedAt: new Date().toISOString(), allowed: true, orgKind: 'Developer Edition' }
    : method === 'POST' ? { counts: { Account: 8, Contact: 12, Opportunity: 12, Case: 16, Lead: 10, Task: 5 }, failures: [] } : { removed: 63, failures: [] });
  if (p === '/t/my-salesforce') return json({ required: true, linked: true, sfUsername: 'owner@demo-company.com', linkedAt: new Date().toISOString() });
  if (p === '/t/person-links') return json([{ email: 'owner@demo-company.com', role: 'owner', sfUsername: 'owner@demo-company.com', linkedAt: new Date().toISOString() }, { email: 'priya@demo-company.com', role: 'builder', sfUsername: 'priya@demo-company.com', linkedAt: new Date().toISOString() }, { email: 'sam@demo-company.com', role: 'approver', sfUsername: null, linkedAt: null }]);
  if (p === '/api/team') return json(DEMO_TEAM);
  if (p === '/api/team/invites') return json({ id: 'i9', link: `${location.origin}/?invite=demo-link`, emailed: false });
  if (/^\/api\/team\/users\/[^/]+\/reset-link$/.test(p)) return json({ link: `${location.origin}/?reset=demo-link`, emailed: true });
  if (p === '/api/alerts') return json(DEMO_ALERTS);
  if (p === '/t/changes') return json(DEMO_CHANGES);
  if (p === '/api/memories' && method === 'GET') return json({ on: true, canTeam: true,
    memories: [
      { id: 'm1', scope: 'team', owner: null, text: 'A hot deal is over $100k and closes this quarter', source: 'user', createdBy: 'priya@demo-company.com', uses: 41, lastUsedAt: ago(1), createdAt: ago(400) },
      { id: 'm2', scope: 'team', owner: null, text: 'We call Cases "tickets" with customers', source: 'assistant', createdBy: 'owner@demo-company.com', uses: 12, lastUsedAt: ago(5), createdAt: ago(200) },
      { id: 'm3', scope: 'personal', owner: 'owner@demo-company.com', text: 'I look after the enterprise accounts in the West', source: 'assistant', createdBy: 'owner@demo-company.com', uses: 9, lastUsedAt: ago(2), createdAt: ago(90) },
      { id: 'm4', scope: 'personal', owner: 'owner@demo-company.com', text: 'Keep answers to one line unless I ask for more', source: 'user', createdBy: 'owner@demo-company.com', uses: 30, lastUsedAt: ago(0.5), createdAt: ago(60) },
    ],
    notes: [
      { id: 1, tenantId: 't', recordId: '500Qy00000KHt2aIAD', note: 'Customer prefers email over phone', author: 'Case triage', createdAt: ago(20) },
      { id: 2, tenantId: 't', recordId: '006Qy00000Abc12IAD', note: 'Already asked for the signed order form on 14 Oct', author: 'Stale deal follow-ups', createdAt: ago(70) },
    ] });
  if (p === '/api/trust') return json({ ai: { provider: 'anthropic', calls30d: 1874, maskedValues30d: 6412 }, masking: { on: true, extraFields: ['Salary__c'] }, retentionDays: 30,
    limits: { aiCalls: 40, toolCalls: 60, tokens: 400000, dailyBudgetUsd: '2' }, agents: { total: 5, live: 3, liveWriting: 3, liveWritingAsking: 2, capped: 2 }, rules: 4,
    changes30d: 1290, undone30d: 3, team: { owner: 1, admin: 1, builder: 1, approver: 1 }, alerts: true, memory: { on: true, team: 6, personal: 11, recordNotes: 48 },
    salesforce: { scopes: ['api', 'refresh_token'], orgs: [{ id: 't', username: 'owner@demo-company.com', url: 'https://demo.my.salesforce.com', status: 'ready', connectedAt: ago(900) }] } });
  if (p === '/api/trust/ai-calls') return json([
    { id: 3, createdAt: ago(0.2), provider: 'anthropic', model: 'claude-haiku-5-5', maskedValues: 2, inputTokens: 812, outputTokens: 64, costUsd: 0.0011, ms: 900, error: null, runId: 'r1', purpose: 'Case triage' },
    { id: 2, createdAt: ago(1), provider: 'anthropic', model: 'claude-opus-5-5', maskedValues: 0, inputTokens: 3400, outputTokens: 410, costUsd: 0.027, ms: 5200, error: null, runId: null, purpose: 'Insights and tools' },
    { id: 1, createdAt: ago(3), provider: 'anthropic', model: 'claude-sonnet-5-5', maskedValues: 4, inputTokens: 2100, outputTokens: 380, costUsd: 0.012, ms: 3900, error: null, runId: 'r2', purpose: 'Draft replies to customer emails' },
  ]);
  if (/^\/api\/trust\/ai-calls\/\d+$/.test(p)) return json({ id: 3, createdAt: ago(0.2), provider: 'anthropic', model: 'claude-haiku-5-5', maskedValues: 2, error: null,
    request: { system: 'You extract structured data from text. Use an empty string when a value is not in the text.', tools: [],
      messages: [{ role: 'user', content: 'Text:\n"""\nSubject: Generator sparks when starting\nDescription: Hi, this is [PERSON_1], reach me at [EMAIL_1]. The generator sparks every time I start it.\n"""' }] },
    response: { stop: 'end_turn', content: [{ text: '{"type":"Electrical","priority":"High","reason":"Sparking is a safety risk."}' }] } });
  if (p === '/api/trust/activity') return json([
    { id: 5, user: 'owner@demo-company.com', action: 'Turned an agent on', target: 'Case triage', ip: '203.0.113.7', createdAt: ago(0.5) },
    { id: 4, user: 'support-lead@demo-company.com', action: 'Approved a change', target: 'r1', ip: '203.0.113.9', createdAt: ago(2) },
    { id: 3, user: 'owner@demo-company.com', action: 'Invited someone', target: 'sam@demo-company.com as approver', ip: '203.0.113.7', createdAt: ago(28) },
    { id: 2, user: 'priya@demo-company.com', action: 'Changed workspace settings', target: 'maskPii, maskFields', ip: '203.0.113.8', createdAt: ago(50) },
    { id: 1, user: 'owner@demo-company.com', action: 'Signed in', target: null, ip: '203.0.113.7', createdAt: ago(51) },
  ]);
  if (/^\/t\/workflows\/[^/]+\/forecast$/.test(p)) return json({ perRunUsd: 0.0016, perRunBasis: 'actual', runsPerMonth: 486, runsBasis: 'Case records created in the last 30 days', monthlyUsd: 0.78, capUsd: 5, spentThisMonthUsd: 0.41, suggestedCapUsd: 2 });
  if (/^\/t\/workflows\/[^/]+\/cap$/.test(p)) return json({ perRunUsd: 0.0016, perRunBasis: 'actual', runsPerMonth: 486, runsBasis: 'Case records created in the last 30 days', monthlyUsd: 0.78, capUsd: body.capUsd, spentThisMonthUsd: 0.41, suggestedCapUsd: 2 });
  if (p === '/t/xray' || p === '/t/xray/scan') return json(DEMO_XRAY);
  if (p === '/t/xray/explain') return json({ object: 'Case', costUsd: 0.004,
    summary: '- When a case is created, the Process Builder "Case escalation" sets Priority to High if the account is Gold.\n- The Apex trigger CaseTrigger also sets Priority (from the case origin) and fills the Status.\n- The Flow "Case assignment" sends new cases to the Support queue and emails the owner.\n- The Workflow Rule "Notify on high priority" emails the support lead.',
    risks: '- Priority is set by both the Process Builder and the trigger: the trigger runs first, so Gold accounts always end up High, whatever the origin says.\n- Two retired tools (Process Builder, Workflow Rule) stop getting fixes.',
    replacement: 'When a Case is created, set Priority to High if the account is Gold, otherwise from the case origin (Phone = Medium, Web = Low), assign it to the Support queue, and email the support lead when Priority is High.' });
  if (p === '/t/xray/replace') return json({ workflowId: 'w9', name: 'Case intake', summary: ['Runs when a Case is created', 'Sets Priority from account tier or origin', 'Assigns to Support', 'Emails the support lead for High'], warnings: [], costUsd: 0.002 });
  if (p === '/t/discover' || p === '/t/discover/scan') return json(DEMO_DISCOVERY);
  if (/^\/t\/discover\/[^/]+\/prove$/.test(p)) return json(DEMO_DISCOVERY.builds['case-triage'].proof);
  if (p === '/t/undo') return json({ restored: 2, deleted: 1, recovered: 0, skipped: [{ recordId: '500Qy00000KHt2aIAD', object: 'Case', why: 'Changed by someone since, kept: Priority' }], failed: [] });
  if (/^\/t\/agents\/[^/]+\/tests$/.test(p) && method === 'GET') return json(DEMO_TESTS);
  if (/^\/t\/agents\/[^/]+\/tests\/recent$/.test(p)) return json([{ question: 'Which accounts have more than 3 open cases?', answer: 'Two accounts: Acme Corp (5) and Globex (4).' }]);
  if (p === '/t/insights') return json((fx.insights as Record<string, unknown>)[url.searchParams.get('period') ?? '30'] ?? fx.insights['30']);
  if (p === '/t/insights/summary') return json(fx.brief);
  if (p === '/t/builder/chat') return json(demoChat(body));
  if (p === '/t/workflows' && method === 'GET') return json(DEMO_AGENTS);
  if (p === '/t/agents' && method === 'GET') return json(DEMO_ASSISTANTS);
  if (p === '/t/conversations') return json([{ id: 'c1', title: 'How many open cases by priority?', channel: 'app', recordId: null, agentId: 'a', agentName: 'Support analyst', updatedAt: ago(3), messages: 4 }, { id: 'c2', title: 'Summarise this case', channel: 'salesforce', recordId: '500Qy', agentId: 'a', agentName: 'Support analyst', updatedAt: ago(30), messages: 2 }]);
  if (/^\/t\/agents\/[^/]+\/run$/.test(p) && body.images?.length) return json({ runId: 'x', conversationId: 'c1', remembered: [], output: "In this demo, answers are sample text, so the image isn't actually read. With your own workspace, the assistant looks at attached images (screenshots of errors, photos of damage, scanned forms) and answers from what it sees, together with your Salesforce data." });
  if (/^\/t\/agents\/[^/]+\/run$/.test(p)) return json({ runId: 'x', conversationId: 'c1', remembered: /remember/i.test(body.input ?? '') ? [{ kind: 'personal', text: 'Looks after the enterprise accounts in the West', id: 'm9' }] : [], output: body.history?.length ? 'Of those 9, 4 are High priority: 00001042, 00001039, 00001031 and 00001027.' : '**9 open cases**, mostly high priority.\n\n- **High:** 4 (oldest is 00001042, 12 days)\n- **Medium:** 3\n- **Low:** 2\n- Two are **past their SLA**: 00001042 and 00001039' });
  if (p === '/api/tools') return json(DEMO_TOOLS);
  if (/^\/t\/agents\/[^/]+\/public$/.test(p)) return json({ enabled: true, origins: 'https://www.demo-company.com', cases: true, greeting: 'Hi! Ask me about our products, or check on your order.', sms: { enabled: true, webhookUrl: 'https://app.crmagents.example/public/twilio/pc_demo' }, snippet: '<script src="https://app.crmagents.example/public/widget.js" data-crmagents-key="pc_demo" async></script>',
    selfService: { verify: true, handoff: true, updatable: ['Phone', 'MailingStreet', 'MailingCity'],
      records: [{ object: 'Case', label: 'Your cases', match: 'contact', fields: ['CaseNumber', 'Subject', 'Status'] }, { object: 'Order', label: 'Your orders', match: 'account', fields: ['OrderNumber', 'Status', 'TotalAmount', 'EffectiveDate'] }],
      actions: [{ key: 'flow:Start_Return', label: 'Start a return', description: 'For delivered orders under 30 days old' }] } });
  if (p === '/t/impact') return json(demoImpact(Number(url.searchParams.get('days') || 30)));
  if (p === '/api/knowledge' && method === 'GET') return json(DEMO_DOCS);
  if (p === '/api/knowledge/search') return json(DEMO_HITS);
  if (p === '/t/record-suggestions' && method === 'GET') return json(DEMO_RECORD_SUGGESTIONS);
  if (p === '/t/suggestions') return json(DEMO_SUGGESTIONS);
  if (/^\/t\/suggestions\/.+\/dismiss$/.test(p)) return json({ ok: true });
  if (p === '/t/agent-health') return json(DEMO_HEALTH);
  if (p === '/t/rules' && method === 'GET') return json(DEMO_RULES);
  if (/^\/t\/runs\/[^/]+\/diagnose$/.test(p)) return json({ explanation: 'Salesforce needs a Subject on every Task, and this step created the task without one because the case had no subject.', action: 'edit', fix: { nodeId: 'sf_task_1', label: 'Create task', summary: 'Use a fallback subject when the case has none', changes: { subject: 'Follow up: {{sf_get_1.record.CaseNumber}}' } }, costUsd: 0.0004 });
  if (/^\/t\/workflows\/[^/]+\/backtest$/.test(p)) return json(DEMO_BACKTEST);
  if (p === '/t/runs' && method === 'GET') return json(url.searchParams.get('status') === 'waiting' ? DEMO_RUNS.filter((r) => r.status === 'waiting') : DEMO_RUNS);
  if (p === '/api/usage') return json({ runs: 23, costUsd: 0.42, budgetUsd: 2, cacheHitRate: 0.61, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
  if (p === '/api/settings') return json({ maskPii: 'on', maskFields: 'Salary__c', maxAiCalls: '', maxToolCalls: '', maxTokens: '', retentionDays: '30', sfClientId: '3MVG9demo', sfLoginUrl: 'https://login.salesforce.com', sfClientSecret: { set: false }, anthropicKey: { set: true }, aiReady: true, actAsPerson: 'on', dailyBudgetUsd: '2', anthropicWorkspaceId: '', aiCacheHours: '24', callbackUrl: 'https://app.crmagents.example/oauth/callback' });
  if (p === '/t/insights/ask') return json({ error: 'Asking questions needs a connected org (this is demo data).' }, 400);
  if (p === '/t/dashboards' && method === 'GET') return json(fx.dashboards);
  if (p === '/t/dashboards/run') return json(body.tiles.map((t: any) => ({ ...fx.dashboard.tiles.find((x: any) => x.title === t.title), ...t })));
  if (/^\/t\/dashboards\/[^/]+$/.test(p) && method === 'GET') return json(fx.dashboard);
  if (p.startsWith('/t/dashboards') && method !== 'GET') return json({ error: 'Demo mode: changes are not saved.' }, 400);
  return method === 'GET' ? json([]) : json({ ok: true });
}

export const DEMO_ONLY = 'Demo mode: this needs your own workspace. Start free to try it on your Salesforce org.';

// Demo mode never reaches the real server: every /api request is answered here, and links that would leave the
// demo (to the server, Salesforce login, payments) are stopped with a note. Anyone can open ?demo, signed in or not.
function note(text: string) {
  let el = document.getElementById('demo-note');
  if (!el) {
    el = document.createElement('div'); el.id = 'demo-note'; el.setAttribute('role', 'status');
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:99999;background:#0a2540;color:#fff;padding:12px 18px;border-radius:10px;font:500 14px Inter,system-ui,sans-serif;box-shadow:0 12px 30px rgba(0,0,0,.3);max-width:90vw';
    document.body.appendChild(el);
  }
  el.textContent = text; el.style.opacity = '1';
  clearTimeout((el as any).t); (el as any).t = setTimeout(() => { el!.style.opacity = '0'; }, 3200);
}
const LEAVES = /^\/(api|oauth|public)\//;
export function leavesDemo(href: string) {
  // Our own server's routes (API, Salesforce login, webhooks) are blocked; other sites (help pages) are fine.
  try { const u = new URL(href, location.origin); return u.origin === location.origin && LEAVES.test(u.pathname); } catch { return false; }
}

export function install() {
  (window as any).__NIMBUS_DEMO__ = true;
  document.addEventListener('click', (e) => {
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (a && leavesDemo(a.getAttribute('href') ?? '')) { e.preventDefault(); e.stopPropagation(); note(DEMO_ONLY); }
  }, true);
  window.addEventListener('nimbus:demo-blocked', () => note(DEMO_ONLY));
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.origin);
    if (!url.pathname.startsWith('/api/')) return real(input, init);
    await delay(150);
    return route((init?.method ?? 'GET').toUpperCase(), url, init?.body ? JSON.parse(String(init.body)) : undefined);
  };
}

// Canned builder conversation, shaped like real replies captured from a dev org.
function demoChat(body: any) {
  const asked = body.messages.filter((m: any) => m.role === 'assistant').length;
  if (asked === 0) return {
    reply: 'Which cases, and what should start it?', question: 'Which cases, and what should start it?', costUsd: 0.0001,
    options: ['When a case is escalated', 'Every new case', 'Cases with no activity for 7 days', 'On demand from a button'],
  };
  const nodes = ['trigger.salesforce', 'sf.getRecord', 'logic.branch', 'logic.approval', 'sf.action', 'sf.createTask', 'util.output']
    .map((type, i) => ({ id: `n${i}`, type, position: { x: i * 280, y: 120 }, config: type === 'sf.action' ? { action: 'flow:SvcCopilotTmpl__AddCaseComment' } : {} }));
  return {
    reply: 'Built "Escalated case follow-up". Review the agent card, then try it on real records.', costUsd: 0.0011,
    draft: {
      name: 'Escalated case follow-up', plan: {}, workflow: { nodes, edges: [] }, estimateUsd: 0, warnings: [], errors: [], questions: [], builderCostUsd: 0.001,
      summary: ['Runs when a Case record arrives in Salesforce', 'Only if Status is Escalated', 'Waits for a person to approve before changing anything',
        'Runs Flow: Add Case Comment (your org\'s own automation)', 'Creates a Task: "Follow up on escalated case [CaseNumber]"'],
    },
  };
}

// Example agents and two weeks of example runs, so lists and charts show their real shape in demo mode.
const g = (types: string[], trigger: Record<string, unknown>) => ({
  nodes: types.map((type, i) => ({ id: `n${i}`, type, position: { x: i * 280, y: 120 }, config: i === 0 ? trigger : {} })), edges: [],
});
const ago = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const DEMO_AGENTS = [
  { id: 'w1', name: 'Case triage', live: true, live_since: ago(300), watch_error: null, updated_at: ago(5), allowed_fields: { Case: ['Status', 'Priority'] }, graph: g(['trigger.salesforce', 'sf.getRecord', 'ai.classify', 'logic.approval', 'sf.updateRecord', 'sf.createTask', 'util.output'], { objectApiName: 'Case' }) },
  { id: 'w2', name: 'Stale deal follow-ups', live: true, live_since: ago(200), watch_error: null, updated_at: ago(30), graph: g(['trigger.schedule', 'sf.query', 'logic.loop', 'sf.createTask', 'util.output'], { every: 'week', at: '08:00' }) },
  { id: 'w3', name: 'Escalated case follow-up', live: true, live_since: ago(50), watch_error: 'Salesforce session expired. Reconnect the org.', updated_at: ago(52), graph: g(['trigger.salesforce', 'logic.branch', 'sf.action', 'sf.createTask', 'util.output'], { objectApiName: 'Case' }) },
  { id: 'w4', name: 'Lead scoring', live: false, live_since: null, watch_error: null, paused_reason: 'Paused after 5 failed runs in a row. Last error: Required field missing: Industry', updated_at: ago(80), graph: g(['trigger.salesforce', 'sf.getRecord', 'ai.extract', 'sf.updateRecord', 'util.output'], { objectApiName: 'Lead' }) },
  { id: 'w5', name: 'Account summary', live: false, live_since: null, watch_error: null, updated_at: ago(400), graph: g(['trigger.manual', 'ai.agent', 'util.output'], {}) },
];
const names = ['Case triage', 'Stale deal follow-ups', 'Escalated case follow-up', 'Lead scoring'];
const STEPS = [
  { nodeId: 'trigger_1', type: 'trigger.salesforce', label: 'Case created', status: 'ok', ms: 2 },
  { nodeId: 'sf_get_1', type: 'sf.getRecord', label: 'Get Case', status: 'ok', ms: 184 },
  { nodeId: 'ai_classify_1', type: 'ai.classify', label: 'Classify', status: 'ok', ms: 912, ai: { tokens: 1240, costUsd: 0.0003 } },
];
const DEMO_RUNS = Array.from({ length: 64 }, (_, i) => {
  const h = Math.floor((i * 5.1) + (i % 3) * 2);
  const status = i === 1 || i === 4 ? 'waiting' : i === 2 ? 'sleeping' : i % 17 === 5 ? 'error' : 'done';
  return { id: `r${i}`, status, agent_name: names[i % names.length], trace: [], output_tokens: 120, cache_read_tokens: 1800, cache_write_tokens: 0,
    cost_usd: i % names.length === 0 ? 0.0003 : i % names.length === 3 ? 0.004 : 0, created_at: ago(h), input_tokens: 0,
    steps: status === 'sleeping' ? [...STEPS, { nodeId: 'wait_1', type: 'logic.wait', label: 'Wait', status: 'waiting', ms: 0, output: { message: 'Waiting until Mon, 19 Oct 2026 08:00:00 GMT' } }] : status === 'waiting' ? [...STEPS, { nodeId: 'approval_1', type: 'logic.approval', label: 'Approve changes', status: 'waiting', ms: 1, output: { message: 'Approve these changes?\n- Create Task "Triage: Billing" on Case 00001042\n- Update Case 00001042: Priority = High' } }]
      : status === 'error' ? [...STEPS.slice(0, 2), { nodeId: 'sf_task_1', type: 'sf.createTask', label: 'Create task', status: 'error', ms: 140, error: 'REQUIRED_FIELD_MISSING: Subject' }] : [...STEPS, { nodeId: 'sf_task_1', type: 'sf.createTask', label: 'Create task', status: 'ok', ms: 160 }],
    output: status === 'done' ? 'Category: Billing (mentions an invoice and a refund).' : null,
    ...(status === 'waiting' ? { assigned_to: i === 1 ? 'owner@demo-company.com' : null, assigned_label: i === 1 ? 'owner@demo-company.com (record owner)' : 'Anyone in the workspace', started_by: i === 4 ? 'asha@demo-company.com' : null } : {}),
    ...(status === 'done' && i % 3 === 0 ? { decided_by: 'owner@demo-company.com', decided_at: ago(h - 1), decision_note: i % 6 === 0 ? 'Looks right' : null } : {}),
    workflow_id: `w${(i % names.length) + 1}` };
});

const DEMO_SUGGESTIONS = [
  { key: 'stale_deals', object: 'Opportunity', count: 13, value: 2115000, title: 'Follow up on stale deals', finding: '13 open deals worth $2.1M have had no activity in 30 days.', request: 'Every Monday at 08:00, find open opportunities with no activity in the last 30 days and create a follow-up task for each owner with the deal name and amount.' },
  { key: 'uncontacted_leads', object: 'Lead', count: 22, title: 'Never let a lead go cold', finding: '22 leads have never been contacted.', request: 'When a lead is created, score it from 0 to 100 and create a call task for hot ones.' },
  { key: 'old_open_cases', object: 'Case', count: 7, title: 'Chase cases open too long', finding: '7 cases have been open for more than two weeks.', request: 'Every day at 09:00, find open cases older than 14 days and create a follow-up task for each owner.' },
];
const DEMO_HEALTH = [
  { workflowId: 'w1', runs: 41, succeeded: 39, failed: 0, waiting: 2, approved: 18, rejected: 0, streak: 18, rejectNotes: [], suggestion: { kind: 'drop_approval', title: 'Ready to run on its own', detail: '18 changes approved in a row and none rejected. You could let it act without asking.' } },
  { workflowId: 'w2', runs: 8, succeeded: 6, failed: 2, waiting: 0, approved: 0, rejected: 0, streak: 0, rejectNotes: [] },
  { workflowId: 'w4', runs: 12, succeeded: 12, failed: 0, waiting: 0, approved: 3, rejected: 4, streak: 0, rejectNotes: ['Score too high for students'], suggestion: { kind: 'review', title: 'People often reject it', detail: '4 of 7 changes were rejected. Reasons: Score too high for students' } },
];
const DEMO_RULES = [
  { id: 'r1', text: 'Never email customers on weekends', enabled: true, created_at: ago(100), rule: { summary: 'Never send email on weekends.', effect: 'block', actions: ['email'], objects: [], when: [], days: [0, 6], hours: null, timezone: 'Asia/Kolkata' } },
  { id: 'r3', text: 'Ask before updating opportunities over 10,000', enabled: true, created_at: ago(80), rule: { summary: 'Ask before updating opportunities with Amount over 10,000.', effect: 'approve', actions: ['update'], objects: ['Opportunity'], when: [{ field: 'Amount', operator: 'greater_than', value: '10000' }], days: [], hours: null, timezone: 'Asia/Kolkata' } },
  { id: 'r2', text: "Don't change accounts owned by the Enterprise team", enabled: true, created_at: ago(90), rule: { summary: "Don't update or add tasks to accounts owned by the Enterprise team.", actions: ['update', 'task'], objects: ['Account'], when: [{ field: 'Owner.Name', operator: 'equals', value: 'Enterprise Team' }], days: [], hours: null, timezone: 'Asia/Kolkata' } },
];
const DEMO_BACKTEST = {
  kind: 'record', object: 'Case', days: 30, total: 412, sampled: 10, acted: 9, skipped: 1, failed: 0,
  actions: [{ action: 'Create Task', count: 371 }, { action: 'Update Case', count: 371 }], costPerRunUsd: 0.0003, estCostUsd: 0.12, errors: [],
  examples: [
    { recordId: '500A', label: '00001042 · Refund not received', status: 'done', result: '', wouldDo: [{ action: 'Update Case', detail: {} }, { action: 'Create Task', detail: {} }], decisions: [{ step: 'Classify', nodeId: 'c', value: 'Billing', input: '', categories: [], examplesUsed: 2 }], costUsd: 0.0003 },
    { recordId: '500B', label: '00001039 · Cannot log in', status: 'done', result: '', wouldDo: [{ action: 'Update Case', detail: {} }, { action: 'Create Task', detail: {} }], decisions: [{ step: 'Classify', nodeId: 'c', value: 'Account access', input: '', categories: [], examplesUsed: 2 }], costUsd: 0.0003 },
    { recordId: '500C', label: '00001031 · Closed duplicate', status: 'done', result: 'Skipped: only runs when Status is not Closed.', wouldDo: [], decisions: [], costUsd: 0 },
  ],
};

const DEMO_ASSISTANTS = [
  { id: 'a1', name: 'Support analyst', systemPrompt: 'You help the support team. Look up cases and accounts and answer briefly with numbers.', tools: ['soql_query', 'get_record', 'describe_object'] },
  { id: 'a2', name: 'Pipeline coach', systemPrompt: 'Review open opportunities and suggest the next best step for each deal owner.', tools: ['soql_query', 'get_record', 'create_task'] },
];
const DEMO_TOOLS = [
  { name: 'soql_query', description: 'Run a read-only SOQL query.', write: false },
  { name: 'get_record', description: 'Read one record by Id.', write: false },
  { name: 'describe_object', description: 'List the fields of an object.', write: false },
  { name: 'create_task', description: 'Create a follow-up Task.', write: true },
  { name: 'update_record', description: 'Update fields on a record.', write: true },
];

const DEMO_DOCS = [
  { id: 'd1', title: 'Enterprise Network Troubleshooting Guide', fileName: 'network-troubleshooting-v1.pdf', kind: 'pdf', chars: 48210, chunks: 41, createdBy: 'owner@demo-company.com', createdAt: ago(30) },
  { id: 'd2', title: 'VPN and Remote Access', fileName: 'vpn-remote-access.docx', kind: 'docx', chars: 12900, chunks: 11, createdBy: 'owner@demo-company.com', createdAt: ago(30) },
  { id: 'd3', title: 'Microsoft 365 Admin Runbook', fileName: 'm365-admin.pdf', kind: 'pdf', chars: 61330, chunks: 52, createdBy: 'it@demo-company.com', createdAt: ago(76) },
  { id: 'd4', title: 'Refund policy', fileName: null, kind: 'text', chars: 2100, chunks: 2, createdBy: 'owner@demo-company.com', createdAt: ago(200) },
];
const DEMO_HITS = [
  { docId: 'd1', title: 'Enterprise Network Troubleshooting Guide', heading: 'Page 4 · WiFi connectivity', rank: 0.4, body: 'Collect user context first: location, device type, IP address, operating system and the exact error message. Confirm whether the issue affects one SSID or all wireless networks. Forget the network and reconnect.' },
  { docId: 'd1', title: 'Enterprise Network Troubleshooting Guide', heading: 'Page 5 · DHCP and IP conflicts', rank: 0.2, body: 'If the device shows a 169.254.x.x address, it did not get an address from DHCP. Renew the lease (ipconfig /renew) and check the DHCP scope is not exhausted.' },
];
const DEMO_RECORD_SUGGESTIONS = [
  { id: 's1', recordId: '500Qy00000gaJpjIAE', objectName: 'Case', title: 'Troubleshooting steps', agentName: 'Case suggestions from guides', status: 'helpful', decidedBy: 'agent@demo-company.com', createdAt: ago(1),
    body: 'WiFi drops for one user on the 3rd floor; other networks work.\n\n1. **Collect context**: device, OS, IP address and exact error [1].\n2. **Check the address**: a 169.254.x.x IP means DHCP failed; renew the lease [2].\n3. **Forget and rejoin** the SSID, then test again [1].\n4. Escalate to the network team if several users on the floor are affected.',
    sources: [{ title: 'Enterprise Network Troubleshooting Guide', section: 'Page 4 · WiFi connectivity' }, { title: 'Enterprise Network Troubleshooting Guide', section: 'Page 5 · DHCP and IP conflicts' }] },
  { id: 's2', recordId: '500Qy00000gaK1aIAE', objectName: 'Case', title: 'Troubleshooting steps', agentName: 'Case suggestions from guides', status: 'new', decidedBy: null, createdAt: ago(3), body: 'VPN error 809 from home: check UDP ports 500 and 4500 are open on the router [1].', sources: [] },
  { id: 's3', recordId: '500Qy00000gaK2bIAE', objectName: 'Case', title: 'Troubleshooting steps', agentName: 'Case suggestions from guides', status: 'not_helpful', decidedBy: 'agent@demo-company.com', createdAt: ago(26), body: 'Reset the Outlook profile and re-add the mailbox [1].', sources: [] },
];

function demoImpact(days: number) {
  const k = days / 30;
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86_400_000);
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    const base = weekend ? 0.6 : 2.2 + (i / days) * 1.6;
    return { date: d.toISOString().slice(0, 10), runs: Math.round(base * 18), hours: +(base + Math.sin(i * 1.7) * 0.4).toFixed(2) };
  });
  const hoursSaved = series.reduce((a, s) => a + s.hours, 0);
  return {
    days, from: series[0].date, to: series[series.length - 1].date,
    assumptions: { hourlyRate: 30, minutes: { change: 2, aiStep: 4, replySent: 6, suggestionUsed: 8, answer: 3, chat: 6 } },
    hoursSaved, valueUsd: hoursSaved * 30, costUsd: 18.4 * k, roi: (hoursSaved * 30) / (18.4 * k),
    previous: { hoursSaved: hoursSaved * 0.78, runs: Math.round(1180 * k), costUsd: 15.1 * k, changes: Math.round(640 * k) },
    runs: { total: Math.round(1432 * k), ok: Math.round(1391 * k), failed: Math.round(29 * k), waiting: 12 },
    work: { changes: Math.round(812 * k), aiSteps: Math.round(1105 * k), repliesSent: Math.round(46 * k), answers: Math.round(214 * k) },
    cost: { agents: 15.9 * k, other: 2.5 * k, perRun: 0.011 },
    website: { conversations: Math.round(388 * k), handedOff: Math.round(71 * k), resolvedRate: 0.82 },
    suggestions: { total: Math.round(402 * k), used: Math.round(287 * k), helpful: Math.round(161 * k), notHelpful: Math.round(23 * k), repliesSuggested: Math.round(158 * k), repliesSentByPeople: Math.round(126 * k) },
    approvals: { approved: Math.round(94 * k), rejected: Math.round(6 * k), medianMinutes: 18 },
    agents: [
      { id: 'a1', name: 'Case triage', kind: 'agent', runs: Math.round(612 * k), ok: Math.round(608 * k), changes: Math.round(598 * k), hours: 31.2 * k, value: 936 * k, cost: 1.9 * k },
      { id: 'a2', name: 'Email replies from guides', kind: 'agent', runs: Math.round(204 * k), ok: Math.round(199 * k), changes: 0, hours: 24.6 * k, value: 738 * k, cost: 4.8 * k },
      { id: 'a3', name: 'Website help', kind: 'assistant', runs: Math.round(388 * k), ok: Math.round(381 * k), changes: 0, hours: 19.4 * k, value: 582 * k, cost: 5.2 * k },
      { id: 'a4', name: 'Lead research', kind: 'agent', runs: Math.round(96 * k), ok: Math.round(94 * k), changes: Math.round(96 * k), hours: 9.6 * k, value: 288 * k, cost: 3.1 * k },
      { id: 'a5', name: 'Stale deal follow-ups', kind: 'agent', runs: Math.round(118 * k), ok: Math.round(113 * k), changes: Math.round(118 * k), hours: 4.7 * k, value: 141 * k, cost: 0.9 * k },
    ],
    series,
  };
}

const DEMO_TEAM = {
  me: 'demo', canManage: true,
  users: [
    { id: 'demo', email: 'owner@demo-company.com', role: 'owner', createdAt: ago(900), lastLoginAt: ago(0.1) },
    { id: 'u2', email: 'priya@demo-company.com', role: 'admin', createdAt: ago(600), lastLoginAt: ago(20) },
    { id: 'u3', email: 'marco@demo-company.com', role: 'builder', createdAt: ago(300), lastLoginAt: ago(50) },
    { id: 'u4', email: 'support-lead@demo-company.com', role: 'approver', createdAt: ago(120), lastLoginAt: ago(3) },
  ],
  invites: [{ id: 'i1', email: 'sam@demo-company.com', role: 'approver', invitedBy: 'owner@demo-company.com', expiresAt: ago(-140), createdAt: ago(28) }],
};
const DEMO_ALERTS = {
  unread: 1,
  alerts: [
    { id: 'a1', kind: 'failing', title: '"Fill missing account data" is failing', body: 'The agent "Fill missing account data" failed its last 3 runs. It will be paused after 5 failures in a row.\n\nLast error: Required field missing: Industry', tenantId: 't', workflowId: 'w', readAt: null, createdAt: ago(2) },
    { id: 'a2', kind: 'paused', title: '"Old lead router" was paused', body: 'The agent failed 5 times in a row, so Nimbus paused it.', tenantId: 't', workflowId: 'w2', readAt: ago(30), createdAt: ago(48) },
  ],
};

const DEMO_TESTS = {
  tests: [
    { id: 'x1', question: 'How many open cases are there?', expect: 'Gives the number of cases that are not closed.', mustInclude: [], mustNot: ['I cannot'] },
    { id: 'x2', question: 'How long do refunds take?', expect: 'Refunds reach the card in 5-7 business days after the item arrives.', mustInclude: ['5-7 business days'], mustNot: ['guarantee'] },
    { id: 'x3', question: 'Create a follow-up task for case 00001042', expect: 'Confirms a task was created on case 00001042.', mustInclude: ['00001042'], mustNot: [] },
  ],
  runs: [
    { id: 'r1', channel: 'internal', status: 'done', passed: 2, total: 3, costUsd: 0.0184, startedBy: 'owner@demo-company.com', createdAt: ago(0.3), finishedAt: ago(0.29), results: [
      { testId: 'x1', question: 'How many open cases are there?', answer: 'There are **14 open cases** right now.', pass: true, reasons: [], tools: ['soql_query'], costUsd: 0.006, ms: 4200 },
      { testId: 'x2', question: 'How long do refunds take?', answer: 'Refunds take 5-7 business days once we receive the returned item.', pass: true, reasons: [], tools: ['search_knowledge'], costUsd: 0.004, ms: 3100 },
      { testId: 'x3', question: 'Create a follow-up task for case 00001042', answer: 'Which case do you mean? Please send the Case ID.', pass: false, reasons: ['Missing "00001042"', 'It asked for the case again instead of creating the task.'], tools: [], costUsd: 0.008, ms: 3900 },
    ] },
    { id: 'r0', channel: 'internal', status: 'done', passed: 3, total: 3, costUsd: 0.017, startedBy: 'owner@demo-company.com', createdAt: ago(30), finishedAt: ago(30), results: [] },
  ],
};

const DEMO_CHANGES = {
  outside: [{ runId: 'r1', label: 'Email reply: Suggest email reply' }],
  changes: [
    { id: 4, run_id: 'r1', op: 'create', object: 'Task', record_id: '00TQy00000EsA7fMAF', before: null, after: { Subject: 'Call back about refund', WhatId: '500Qy00000KHt2aIAD' }, undoable: true, undone_at: null, undone_by: null, undo_result: null, created_at: ago(0.5), agent_name: 'Case triage' },
    { id: 3, run_id: 'r1', op: 'update', object: 'Case', record_id: '500Qy00000KHt2aIAD', before: { Priority: 'Low', Status: 'New' }, after: { Priority: 'High', Status: 'Escalated' }, undoable: true, undone_at: null, undone_by: null, undo_result: null, created_at: ago(0.5), agent_name: 'Case triage' },
    { id: 2, run_id: 'r2', op: 'update', object: 'Case', record_id: '500Qy00000KHt9bIAD', before: { Priority: 'Medium' }, after: { Priority: 'High' }, undoable: true, undone_at: null, undone_by: null, undo_result: null, created_at: ago(3), agent_name: 'Case triage' },
    { id: 1, run_id: 'r3', op: 'update', object: 'Case', record_id: '500Qy00000KHsZ1IAL', before: { Status: 'New' }, after: { Status: 'Working' }, undoable: true, undone_at: ago(20), undone_by: 'owner@demo-company.com', undo_result: 'Restored', created_at: ago(22), agent_name: 'Case triage' },
  ],
};

const DEMO_DISCOVERY = {
  totalHours: 71.4, hourlyRate: 30, checked: 10, scannedAt: ago(0.1),
  opportunities: [
    { id: 'email-replies', title: 'Draft replies to customer emails', area: 'Service', evidence: '412 customer emails arrived on cases in the last 30 days, each answered by hand', volume: 412, minutesEach: 6, hoursPerMonth: 41.2, valuePerMonth: 1236, request: '' },
    { id: 'case-triage', title: 'Triage new cases', area: 'Service', evidence: '486 cases in the last 30 days were sorted by hand (priority or type set by a person)', volume: 486, minutesEach: 2, hoursPerMonth: 16.2, valuePerMonth: 486, request: '', compareFields: ['Priority', 'Type'] },
    { id: 'stale-deals', title: 'Nudge owners on stale deals', area: 'Sales', evidence: '94 open deals have had no activity for 14+ days', volume: 94, minutesEach: 5, hoursPerMonth: 7.8, valuePerMonth: 235, request: '' },
    { id: 'lead-research', title: 'Research new leads on the web', area: 'Sales', evidence: '31 new leads from the last 30 days have had no call, email or task yet', volume: 31, minutesEach: 10, hoursPerMonth: 5.2, valuePerMonth: 155, request: '' },
    { id: 'duplicates', title: 'Find and merge duplicates', area: 'Operations', evidence: '15 leads are duplicates of another lead with the same email', volume: 15, minutesEach: 4, hoursPerMonth: 1, valuePerMonth: 30, request: '' },
  ],
  builds: {
    'case-triage': { opportunity: 'case-triage', workflowId: 'w1', name: 'Case triage on create', live: false, proof: {
      workflowId: 'w1', name: 'Case triage on create', estimateUsd: 0.0016, warnings: [], replayed: 8, ok: 8, costUsd: 0.034, monthlyCostUsd: 0.78, hoursPerMonth: 16.2, valuePerMonth: 486, learned: 40,
      summary: ['Runs when a Case is created', 'AI pulls out: type, priority, reason', 'Waits for a person to approve before changing anything', 'Updates the Case: Type, Priority'],
      agreementBefore: { checked: 16, matched: 11, rate: 0.69, examples: [] },
      agreement: { checked: 16, matched: 14, rate: 0.875, examples: [
        { recordId: '500A1', field: 'Priority', agent: 'High', team: 'High', same: true }, { recordId: '500A1', field: 'Type', agent: 'Electrical', team: 'Electrical', same: true },
        { recordId: '500A2', field: 'Priority', agent: 'Medium', team: 'Medium', same: true }, { recordId: '500A2', field: 'Type', agent: 'Mechanical', team: 'Mechanical', same: true },
        { recordId: '500A3', field: 'Priority', agent: 'Low', team: 'Medium', same: false }, { recordId: '500A3', field: 'Type', agent: 'Other', team: 'Other', same: true },
        { recordId: '500A4', field: 'Priority', agent: 'High', team: 'High', same: true }, { recordId: '500A4', field: 'Type', agent: 'Structural', team: 'Structural', same: true },
      ] },
      rows: [
        { recordId: '500A1', label: '00001042 · Generator sparks when starting', status: 'done', wouldDo: [] },
        { recordId: '500A2', label: '00001041 · Rotor making grinding noise', status: 'done', wouldDo: [] },
        { recordId: '500A3', label: '00001039 · Question about warranty', status: 'done', wouldDo: [] },
        { recordId: '500A4', label: '00001036 · Frame cracked after delivery', status: 'done', wouldDo: [] },
      ],
    } },
  },
};

const xa = (kind: string, name: string, object: string, event: string, writes: string[] = [], extra: Record<string, unknown> = {}) => ({ kind, name, label: name, object, event, timing: 'after save', writes: writes.length ? [{ object, fields: writes }] : [], creates: [], steps: 4, actions: [], order: null, lastModified: ago(9000), ...extra });
const DEMO_XRAY = {
  score: 58, scannedAt: ago(0.05), flowsRead: 14, flowsSkipped: 0,
  automations: [
    xa('process', 'Case escalation', 'Case', 'any', ['Priority']), xa('trigger', 'CaseTrigger', 'Case', 'created or updated', ['Priority', 'Status']),
    xa('flow', 'Case assignment', 'Case', 'created', ['OwnerId']), xa('workflow', 'Notify on high priority', 'Case', 'any'), xa('flow', 'Case SLA timer', 'Case', 'created or updated', ['SLA_Due__c']),
    xa('flow', 'Lead scoring', 'Lead', 'created or updated', ['Rating']), xa('process', 'Lead rating', 'Lead', 'any', ['Rating']),
    xa('flow', 'Opportunity next step', 'Opportunity', 'updated', ['NextStep']), xa('trigger', 'OpportunityTrigger', 'Opportunity', 'created or updated', ['Probability']),
  ],
  findings: [
    { severity: 'high', kind: 'conflict', object: 'Case', title: '2 automations set Case.Priority', detail: 'Process Builder "Case escalation", Apex trigger "CaseTrigger" all write Priority. Whichever runs last wins, so the value depends on the order Salesforce runs them in.', automations: [] },
    { severity: 'high', kind: 'conflict', object: 'Lead', title: '2 automations set Lead.Rating', detail: 'Flow "Lead scoring", Process Builder "Lead rating" all write Rating. Whichever runs last wins.', automations: [] },
    { severity: 'medium', kind: 'crowded', object: 'Case', title: '5 automations run when a Case is saved', detail: 'Process Builder, Apex trigger, Flow, Workflow Rule all react to Case saves, across different tools. Good candidates to combine.', automations: [] },
    { severity: 'medium', kind: 'legacy', object: 'Case', title: 'Process Builder "Case escalation" is a retired tool', detail: 'Salesforce ended support for Process Builder at the end of 2025. Move it to a Flow or an agent.', automations: [] },
    { severity: 'medium', kind: 'legacy', object: 'Lead', title: 'Process Builder "Lead rating" is a retired tool', detail: 'Salesforce ended support for Process Builder at the end of 2025.', automations: [] },
    { severity: 'medium', kind: 'legacy', object: 'Case', title: 'Workflow Rule "Notify on high priority" is a retired tool', detail: 'Salesforce ended support for Workflow Rules at the end of 2025.', automations: [] },
    { severity: 'low', kind: 'clutter', object: 'Account', title: 'Inactive Flow "Old account sync" untouched for over a year', detail: 'It never runs. If nobody needs it, delete it.', automations: [] },
  ],
  objects: [
    { object: 'Case', count: 5, kinds: { process: 1, trigger: 1, flow: 2, workflow: 1 }, rules: 3, findings: 4 },
    { object: 'Lead', count: 2, kinds: { flow: 1, process: 1 }, rules: 1, findings: 2 },
    { object: 'Opportunity', count: 2, kinds: { flow: 1, trigger: 1 }, rules: 2, findings: 0 },
  ],
};

const DEMO_ADMIN = (() => {
  const d = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
  const accounts = [
    { id: 'w1', tags: ['enterprise'], staffOwner: 'sales@crmagents.example', orgIssue: false, everLive: true, notes: 2, stage: 'paying', health: 'active', mrr: 199, name: 'Northwind Service', plan: 'pro', trialEndsAt: null, requestedPlan: null, planSetBy: 'stripe', createdAt: d(900), orgs: 2, users: 14, owner: 'maria@northwind.example', lastActive: d(0.4), liveAgents: 9, aiCost30: 41.2, subStatus: 'active', subInterval: 'month', subAmountCents: 19900, renewsAt: d(-300), purchasedBy: 'maria@northwind.example', cancelAtPeriodEnd: false },
    { id: 'w2', tags: ['upsell'], staffOwner: 'owner@demo-company.com', orgIssue: false, everLive: true, notes: 1, stage: 'past_due', health: 'active', mrr: 40.83, name: 'Acme Field Ops', plan: 'plus', trialEndsAt: null, requestedPlan: 'pro', planSetBy: 'stripe', createdAt: d(600), orgs: 1, users: 6, owner: 'dev@acme.example', lastActive: d(5), liveAgents: 4, aiCost30: 8.7, subStatus: 'past_due', subInterval: 'year', subAmountCents: 49000, renewsAt: d(-2000), purchasedBy: 'finance@acme.example', cancelAtPeriodEnd: false },
    { id: 'w3', tags: [], staffOwner: null, orgIssue: false, everLive: true, notes: 0, stage: 'expired', health: 'quiet', mrr: 0, name: 'Globex Support', plan: 'basic', trialEndsAt: d(48), requestedPlan: 'plus', planSetBy: 'sign-up trial', createdAt: d(290), orgs: 1, users: 2, owner: 'li@globex.example', lastActive: d(20), liveAgents: 2, aiCost30: 0.6, subStatus: null, subInterval: null, subAmountCents: null, renewsAt: null, purchasedBy: null, cancelAtPeriodEnd: null },
    { id: 'w4', tags: [], staffOwner: null, orgIssue: true, everLive: false, notes: 0, stage: 'trial', health: 'at_risk', mrr: 0, name: 'Initech', plan: 'basic', trialEndsAt: d(-30), requestedPlan: null, planSetBy: 'sign-up trial', createdAt: d(380), orgs: 1, users: 1, owner: 'peter@initech.example', lastActive: d(120), liveAgents: 0, aiCost30: 0.1, subStatus: null, subInterval: null, subAmountCents: null, renewsAt: null, purchasedBy: null, cancelAtPeriodEnd: null },
    { id: 'w5', tags: ['partner', 'enterprise'], staffOwner: 'sales@crmagents.example', orgIssue: false, everLive: true, notes: 4, stage: 'comped', health: 'active', mrr: 0, name: 'Umbrella Partners', plan: 'promax', trialEndsAt: null, requestedPlan: null, planSetBy: 'owner@crmagents.example', createdAt: d(2000), orgs: 11, users: 32, owner: 'ops@umbrella.example', lastActive: d(1), liveAgents: 37, aiCost30: 212.4, subStatus: null, subInterval: null, subAmountCents: null, renewsAt: null, purchasedBy: null, cancelAtPeriodEnd: null },
  ];
  return {
    overview: {
      billingConfigured: false,
      kpis: { workspaces: { value: 5, sub: '3 new in 30 days', change: 0.5, changeLabel: 'vs previous 30' }, mrr: { value: 239.83, arr: 2878, paying: 2, pastDue: 1 }, trials: { value: 1, ending: 1, expired: 1 },
        people: { value: 55, active7: 31, change: 0.12 }, ai: { value: 263.0, runs: 18420, change: 0.31 }, revenue: { value: 199, change: -0.6 }, requests: 2 },
      stages: { trial: 1, expired: 1, paying: 1, past_due: 1, churned: 0, comped: 1 }, plans: { basic: 2, plus: 1, pro: 1, promax: 1 },
      funnel: [{ step: 'Signed up', n: 5 }, { step: 'Connected Salesforce', n: 5 }, { step: 'Turned an agent on', n: 4 }, { step: 'Paying', n: 2 }],
      attention: {
        trialsEnding: [{ id: 'w4', name: 'Initech', owner: 'peter@initech.example', why: 'ends in 1 day' }],
        paymentFailed: [{ id: 'w2', name: 'Acme Field Ops', owner: 'dev@acme.example', why: 'card declined 1d ago' }],
        upgradeAsks: [{ id: 'w2', name: 'Acme Field Ops', owner: 'dev@acme.example', why: 'asked for Pro' }, { id: 'w3', name: 'Globex Support', owner: 'li@globex.example', why: 'asked for Plus' }],
        churnRisk: [], disconnected: [{ id: 'w4', name: 'Initech', owner: 'peter@initech.example', why: 'org login expired' }] },
      series: Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.now() - (29 - i) * 86_400_000).toISOString().slice(0, 10), signups: [0, 1, 0, 0, 2, 0, 1][i % 7] })) },
    revenue: { mrr: 239.83, arr: 2878, paying: 2, billingConfigured: false,
      byMonth: Array.from({ length: 6 }, (_, i) => { const m = new Date(); m.setDate(1); m.setMonth(m.getMonth() - 5 + i); return { month: m.toISOString().slice(0, 7), cents: [0, 0, 49000, 19900, 19900, 19900][i], started: [0, 0, 1, 1, 0, 0][i], canceled: 0 }; }),
      subscriptions: [{ id: 'w1', name: 'Northwind Service', plan: 'pro', status: 'active', interval: 'month', amountCents: 19900, mrr: 199, renewsAt: d(-300), purchasedBy: 'maria@northwind.example', cancelAtPeriodEnd: false },
        { id: 'w2', name: 'Acme Field Ops', plan: 'plus', status: 'past_due', interval: 'year', amountCents: 49000, mrr: 40.83, renewsAt: d(-2000), purchasedBy: 'finance@acme.example', cancelAtPeriodEnd: false }] },
    log: [{ at: d(3), by: 'owner@demo-company.com', accountId: 'w2', accountName: 'Acme Field Ops', what: 'Added a note', detail: 'Called finance: new card coming Monday' },
      { at: d(50), by: 'sales@crmagents.example', accountId: 'w5', accountName: 'Umbrella Partners', what: 'Changed plan Pro → Pro Max', detail: 'Partner agreement, invoiced yearly' },
      { at: d(80), by: 'owner@demo-company.com', accountId: null, accountName: null, what: 'Request marked contacted', detail: 'Jo Park · Park Consulting' }],
    accounts,
    detail: { account: accounts[1], plan: { plan: 'plus', name: 'Plus', trialEndsAt: null, trialEnded: false, requestedPlan: 'pro', features: [], limits: { orgs: 2, users: 10, liveAgents: 15, assistants: null }, usage: { orgs: 1, users: 6, liveAgents: 4, assistants: 3 } },
      members: [{ email: 'dev@acme.example', role: 'owner', createdAt: d(600), lastLoginAt: d(5) }, { email: 'finance@acme.example', role: 'admin', createdAt: d(500), lastLoginAt: d(70) }, { email: 'agent1@acme.example', role: 'approver', createdAt: d(300), lastLoginAt: d(8) }],
      invites: [{ email: 'new@acme.example', role: 'builder', invitedBy: 'dev@acme.example', expiresAt: d(-100) }],
      orgs: [{ username: 'admin@acme.example', url: 'https://acme.my.salesforce.com', status: 'ready', usePackage: true, connectedAt: d(590) }],
      subscription: { plan: 'plus', interval: 'year', status: 'past_due', amountCents: 49000, currency: 'usd', renewsAt: d(-2000), cancelAtPeriodEnd: false, purchasedBy: 'finance@acme.example', startedAt: d(580), customerId: 'cus_demo123', hasSubscription: true },
      payments: [{ type: 'payment_failed', plan: null, amountCents: 49000, currency: 'usd', invoiceUrl: null, detail: null, createdAt: d(30) }, { type: 'subscription_started', plan: 'plus', amountCents: 49000, currency: 'usd', invoiceUrl: null, detail: 'Bought by finance@acme.example', createdAt: d(580) }],
      planHistory: [{ from: 'basic', to: 'plus', by: 'stripe', reason: 'Subscription active', createdAt: d(580) }, { from: null, to: 'basic', by: 'sign-up', reason: '14-day trial', createdAt: d(600) }],
      requests: [{ id: 3, topic: 'upgrade', source: 'upgrade', status: 'new', message: 'Upgrade request: pro', createdAt: d(10) }],
      activity: [{ user: 'dev@acme.example', action: 'Turned an agent on', target: 'Case triage', createdAt: d(5) }, { user: 'finance@acme.example', action: 'Asked to upgrade to pro', target: null, createdAt: d(10) }],
      notes: [{ id: 1, author: 'owner@demo-company.com', text: 'Called finance: new card coming Monday. Keep Plus running until then.', createdAt: d(3) }],
      timeline: [
        { at: d(3), kind: 'note', text: 'Note added', by: 'owner@demo-company.com', detail: 'Called finance: new card coming Monday' },
        { at: d(10), kind: 'request', text: 'Asked to upgrade to Pro', by: 'finance@acme.example' },
        { at: d(30), kind: 'billing', text: 'Payment failed', detail: '$490' },
        { at: d(300), kind: 'person', text: 'agent1@acme.example joined as approver' },
        { at: d(580), kind: 'plan', text: 'Basic → Plus', by: 'stripe', detail: 'Subscription active' },
        { at: d(580), kind: 'billing', text: 'Subscription started', by: 'finance@acme.example', detail: '$490 / year' },
        { at: d(590), kind: 'org', text: 'Connected admin@acme.example' },
        { at: d(600), kind: 'person', text: 'Workspace created', by: 'dev@acme.example', detail: '14-day trial' }],
      usage30: { runs: 1840, cost: 8.7 } },
    users: [{ id: 'u1', email: 'maria@northwind.example', role: 'owner', createdAt: d(900), lastLoginAt: d(0.4), accountId: 'w1', accountName: 'Northwind Service', plan: 'pro' }, { id: 'u2', email: 'dev@acme.example', role: 'owner', createdAt: d(600), lastLoginAt: d(5), accountId: 'w2', accountName: 'Acme Field Ops', plan: 'plus' }, { id: 'u3', email: 'li@globex.example', role: 'owner', createdAt: d(290), lastLoginAt: d(20), accountId: 'w3', accountName: 'Globex Support', plan: 'basic' }],
    payments: [{ id: 1, type: 'payment_succeeded', plan: null, amountCents: 19900, currency: 'usd', invoiceUrl: 'https://invoice.stripe.example/1', detail: null, createdAt: d(20), accountId: 'w1', accountName: 'Northwind Service' }, { id: 2, type: 'payment_failed', plan: null, amountCents: 49000, currency: 'usd', invoiceUrl: null, detail: null, createdAt: d(30), accountId: 'w2', accountName: 'Acme Field Ops' }],
    requests: [
      { id: 3, name: 'finance@acme.example', email: 'finance@acme.example', company: 'Acme Field Ops', size: null, message: 'Upgrade request: pro', topic: 'upgrade', source: 'upgrade', status: 'new', notes: null, handledBy: null, assignedTo: 'owner@demo-company.com', updatedAt: null, createdAt: d(10), accountId: 'w2', accountName: 'Acme Field Ops' },
      { id: 2, name: 'Sam Rivera', email: 'sam@bigco.example', company: 'BigCo', size: '1200', message: 'We run 4 orgs and want agents for service and sales. Can you host in the EU?', topic: 'sales', source: 'pricing', status: 'new', notes: null, handledBy: null, assignedTo: null, updatedAt: null, createdAt: d(26), accountId: null, accountName: null },
      { id: 1, name: 'Jo Park', email: 'jo@consult.example', company: 'Park Consulting', size: null, message: 'Salesforce partner here: interested in rolling agents out to our clients.', topic: 'partnership', source: 'contact', status: 'contacted', notes: 'Call booked for Tuesday', handledBy: 'owner@crmagents.example', assignedTo: 'sales@crmagents.example', updatedAt: d(40), createdAt: d(80), accountId: null, accountName: null },
    ],
  };
})();
