import fx from './fixtures.json';

// Demo mode (/?demo): the real UI on captured data, no login or Salesforce needed. Used for screenshots and sales demos.
// Refresh the data with apps/api/scripts/capture-demo.mts.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function route(method: string, url: URL, body: any): Response {
  const p = url.pathname.replace(/^\/api\/tenants\/[^/]+/, '/t');
  if (p === '/api/auth/me') return json({ id: 'demo', email: 'owner@demo-company.com', accountName: 'Demo Company', role: 'owner' });
  if (p === '/api/tenants') return json([fx.tenant]);
  if (p === '/t/insights') return json((fx.insights as Record<string, unknown>)[url.searchParams.get('period') ?? '30'] ?? fx.insights['30']);
  if (p === '/t/insights/summary') return json(fx.brief);
  if (p === '/t/builder/chat') return json(demoChat(body));
  if (p === '/t/workflows' && method === 'GET') return json(DEMO_AGENTS);
  if (p === '/t/agents' && method === 'GET') return json(DEMO_ASSISTANTS);
  if (p === '/api/tools') return json(DEMO_TOOLS);
  if (p === '/t/suggestions') return json(DEMO_SUGGESTIONS);
  if (/^\/t\/suggestions\/.+\/dismiss$/.test(p)) return json({ ok: true });
  if (p === '/t/agent-health') return json(DEMO_HEALTH);
  if (p === '/t/rules' && method === 'GET') return json(DEMO_RULES);
  if (/^\/t\/runs\/[^/]+\/diagnose$/.test(p)) return json({ explanation: 'Salesforce needs a Subject on every Task, and this step created the task without one because the case had no subject.', action: 'edit', fix: { nodeId: 'sf_task_1', label: 'Create task', summary: 'Use a fallback subject when the case has none', changes: { subject: 'Follow up: {{sf_get_1.record.CaseNumber}}' } }, costUsd: 0.0004 });
  if (/^\/t\/workflows\/[^/]+\/backtest$/.test(p)) return json(DEMO_BACKTEST);
  if (p === '/t/runs' && method === 'GET') return json(url.searchParams.get('status') === 'waiting' ? DEMO_RUNS.filter((r) => r.status === 'waiting') : DEMO_RUNS);
  if (p === '/api/usage') return json({ runs: 23, costUsd: 0.42, budgetUsd: 2, cacheHitRate: 0.61, tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } });
  if (p === '/api/settings') return json({ sfClientId: '3MVG9demo', sfLoginUrl: 'https://login.salesforce.com', sfClientSecret: { set: false }, anthropicKey: { set: true }, dailyBudgetUsd: '2', anthropicWorkspaceId: '', aiCacheHours: '24', callbackUrl: 'https://app.crmagents.example/oauth/callback' });
  if (p === '/t/insights/ask') return json({ error: 'Asking questions needs a connected org (this is demo data).' }, 400);
  if (p === '/t/dashboards' && method === 'GET') return json(fx.dashboards);
  if (p === '/t/dashboards/run') return json(body.tiles.map((t: any) => ({ ...fx.dashboard.tiles.find((x: any) => x.title === t.title), ...t })));
  if (/^\/t\/dashboards\/[^/]+$/.test(p) && method === 'GET') return json(fx.dashboard);
  if (p.startsWith('/t/dashboards') && method !== 'GET') return json({ error: 'Demo mode: changes are not saved.' }, 400);
  return method === 'GET' ? json([]) : json({ ok: true });
}

export function install() {
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
  { id: 'w1', name: 'Case triage', live: true, live_since: ago(300), watch_error: null, updated_at: ago(5), graph: g(['trigger.salesforce', 'sf.getRecord', 'ai.classify', 'logic.approval', 'sf.createTask', 'util.output'], { objectApiName: 'Case' }) },
  { id: 'w2', name: 'Stale deal follow-ups', live: true, live_since: ago(200), watch_error: null, updated_at: ago(30), graph: g(['trigger.schedule', 'sf.query', 'logic.loop', 'sf.createTask', 'util.output'], { every: 'week', at: '08:00' }) },
  { id: 'w3', name: 'Escalated case follow-up', live: true, live_since: ago(50), watch_error: 'Salesforce session expired. Reconnect the org.', updated_at: ago(52), graph: g(['trigger.salesforce', 'logic.branch', 'sf.action', 'sf.createTask', 'util.output'], { objectApiName: 'Case' }) },
  { id: 'w4', name: 'Lead scoring', live: false, live_since: null, watch_error: null, updated_at: ago(80), graph: g(['trigger.salesforce', 'sf.getRecord', 'ai.extract', 'sf.updateRecord', 'util.output'], { objectApiName: 'Lead' }) },
  { id: 'w5', name: 'Account summary', live: false, live_since: null, watch_error: null, updated_at: ago(400), graph: g(['trigger.manual', 'ai.agent', 'util.output'], {}) },
];
const names = ['Case triage', 'Stale deal follow-ups', 'Escalated case follow-up', 'Lead scoring'];
const STEPS = [
  { nodeId: 'trigger_1', type: 'trigger.salesforce', label: 'Case created', status: 'ok', ms: 2 },
  { nodeId: 'sf_get_1', type: 'sf.getRecord', label: 'Get Case', status: 'ok', ms: 184 },
  { nodeId: 'ai_classify_1', type: 'ai.classify', label: 'Classify', status: 'ok', ms: 912 },
];
const DEMO_RUNS = Array.from({ length: 64 }, (_, i) => {
  const h = Math.floor((i * 5.1) + (i % 3) * 2);
  const status = i === 1 || i === 4 ? 'waiting' : i % 17 === 5 ? 'error' : 'done';
  return { id: `r${i}`, status, agent_name: names[i % names.length], trace: [], output_tokens: 120, cache_read_tokens: 1800, cache_write_tokens: 0,
    cost_usd: i % names.length === 0 ? 0.0003 : i % names.length === 3 ? 0.004 : 0, created_at: ago(h), input_tokens: 0,
    steps: status === 'waiting' ? [...STEPS, { nodeId: 'approval_1', type: 'logic.approval', label: 'Approve changes', status: 'waiting', ms: 1, output: { message: 'Approve these changes?\n- Create Task "Triage: Billing" on Case 00001042\n- Update Case 00001042: Priority = High' } }]
      : status === 'error' ? [...STEPS.slice(0, 2), { nodeId: 'sf_task_1', type: 'sf.createTask', label: 'Create task', status: 'error', ms: 140, error: 'REQUIRED_FIELD_MISSING: Subject' }] : [...STEPS, { nodeId: 'sf_task_1', type: 'sf.createTask', label: 'Create task', status: 'ok', ms: 160 }],
    output: status === 'done' ? 'Category: Billing (mentions an invoice and a refund).' : null, workflow_id: `w${(i % names.length) + 1}` };
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
  { id: 'r1', text: 'Never email customers on weekends', enabled: true, created_at: ago(100), rule: { summary: 'Never send email on weekends.', actions: ['email'], objects: [], when: [], days: [0, 6], hours: null, timezone: 'Asia/Kolkata' } },
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
