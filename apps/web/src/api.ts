/** True in demo mode (?demo): nothing reaches the real server. */
export const isDemo = () => !!(window as unknown as { __NIMBUS_DEMO__?: boolean }).__NIMBUS_DEMO__;
/** Go to a server or external address, unless this is the demo (then say so instead). */
export function leaveTo(url: string) {
  if (isDemo()) { window.dispatchEvent(new Event('nimbus:demo-blocked')); return; }
  window.location.href = url;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('crmagents:unauthorized'));
  // Something the plan doesn't include: actions open the upgrade prompt (pages show their own locked state).
  if (res.status === 402 && method !== 'GET') window.dispatchEvent(new CustomEvent('crmagents:upgrade', { detail: { message: j.error, plan: j.plan } }));
  // The workspace acts as each person in Salesforce and this person hasn't linked their login: ask them to.
  if (res.status === 409 && j.code === 'sf_link_required') window.dispatchEvent(new CustomEvent('crmagents:sf-link', { detail: { message: j.error, tenantId: path.match(/^\/api\/tenants\/([0-9a-f-]{36})/i)?.[1] } }));
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j as T;
}

import type { Workflow } from '@crmagents/shared';

/** The browser's time zone, e.g. "Asia/Kolkata" (schedules run in it). */
export const localTz = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };
export type { Workflow };
export interface Tenant {
  id: string; sf_org_id: string; sf_instance_url: string; sf_username: string | null;
  setup_status?: string; setup_message?: string | null; use_package?: boolean;
  /** Salesforce API calls used in the last 24 hours, as last reported by the org. */
  api_used?: number | null; api_max?: number | null; api_checked_at?: string | null;
}
export interface KnowledgeDoc { id: string; title: string; fileName: string | null; kind: 'pdf' | 'docx' | 'text'; chars: number; chunks: number; createdBy: string | null; createdAt: string; source?: string }
export interface KnowledgeSource { id: string; kind: 'articles' | 'library'; library: string | null; lastSyncedAt: string | null; lastResult: string | null; org: string | null; tenantId: string }
export interface KnowledgeHit { docId: string; title: string; heading: string; body: string; rank: number }
export interface RecordSuggestion {
  id: string; recordId: string; objectName: string; title: string; body: string; sources: { title: string; section: string }[];
  status: 'new' | 'helpful' | 'not_helpful' | 'dismissed' | 'sent'; agentName: string | null; decidedBy: string | null; createdAt: string;
  kind?: string; meta?: { to?: string; subject?: string };
}
export interface ImpactAssumptions { hourlyRate: number; minutes: { change: number; aiStep: number; replySent: number; suggestionUsed: number; answer: number; chat: number } }
export interface Impact {
  days: number; from: string; to: string; assumptions: ImpactAssumptions;
  hoursSaved: number; valueUsd: number; costUsd: number; roi: number | null;
  previous: { hoursSaved: number; runs: number; costUsd: number; changes: number };
  runs: { total: number; ok: number; failed: number; waiting: number };
  work: { changes: number; aiSteps: number; repliesSent: number; answers: number };
  cost: { agents: number; other: number; perRun: number };
  website: { conversations: number; handedOff: number; resolvedRate: number | null };
  suggestions: { total: number; used: number; helpful: number; notHelpful: number; repliesSuggested: number; repliesSentByPeople: number };
  approvals: { approved: number; rejected: number; medianMinutes: number | null };
  agents: { id: string; name: string; kind: 'agent' | 'assistant'; runs: number; ok: number; changes: number; hours: number; value: number; cost: number }[];
  series: { date: string; runs: number; hours: number }[];
}
export interface SfPage { id: string; label: string; managed: boolean }
export interface SelfService {
  verify: boolean;
  records: { object: string; label: string; match: 'contact' | 'account' | 'email'; emailField?: string; fields: string[] }[];
  actions: { key: string; label: string; description?: string }[];
  updatable: string[];
  handoff: boolean;
  meetings: { enabled: boolean; with: string[]; durationMin: number; days: number; subject: string };
}
export interface PublicChat { enabled: boolean; origins: string; cases: boolean; greeting: string; snippet: string; selfService: SelfService; sms?: { enabled: boolean; webhookUrl: string } }
export interface Agent { id: string; name: string; systemPrompt: string; tools: string[] }
export interface AssistantTest { id: string; question: string; expect: string; mustInclude: string[]; mustNot: string[] }
export interface TestResult { testId: string; question: string; answer: string; pass: boolean; reasons: string[]; tools: string[]; costUsd: number; ms: number; error?: string }
export interface TestRun { id: string; channel: 'internal' | 'website'; status: 'running' | 'done' | 'error'; passed: number; total: number; costUsd: number; results: TestResult[]; startedBy: string | null; createdAt: string; finishedAt: string | null }
export interface ToolInfo { name: string; description: string; write: boolean }
export interface Run {
  id: string; status: string; output: string | null; agent_name: string | null;
  trace: { tool: string; ok: boolean; error?: string; input: unknown }[];
  input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
  cost_usd: number; created_at: string;
  steps: Step[]; workflow_id: string | null;
  decided_by?: string | null; decision_note?: string | null; decided_at?: string | null; purged_at?: string | null;
  started_by?: string | null; assigned_to?: string | null; assigned_label?: string | null;
}
export interface Step {
  nodeId: string; type: string; label: string; status: 'ok' | 'error' | 'waiting'; ai?: { tokens: number; costUsd: number };
  output?: unknown; error?: string; ms: number; iteration?: number; reused?: boolean; trace?: { tool: string; ok: boolean; error?: string }[];
}
export interface RunUsage { input: number; cacheWrite: number; cacheRead: number; output: number; costUsd: number }
export interface RunResult { runId: string; status: string; output: string; error?: string; steps: Step[]; usage?: RunUsage }
export interface Draft {
  name: string; plan: unknown; workflow: Workflow; summary: string[]; estimateUsd: number;
  warnings: string[]; errors: string[]; questions: string[];
  sample?: { recordId: string; objectApiName: string }; builderCostUsd: number;
}
export interface Suggestion { key: string; title: string; finding: string; request: string; count: number; value?: number; object: string }
export interface BacktestResult {
  kind: 'record' | 'schedule'; object: string; days: number; total: number; sampled: number; acted: number; skipped: number; failed: number;
  actions: { action: string; count: number }[]; costPerRunUsd: number; estCostUsd: number; examples: PreviewRow[]; errors: string[];
}
export interface AgentHealth {
  workflowId: string; runs: number; succeeded: number; failed: number; waiting: number; approved: number; rejected: number; streak: number;
  lastError?: string; rejectNotes: string[]; suggestion?: { kind: 'drop_approval' | 'review' | 'fix'; title: string; detail: string };
}
export interface Diagnosis { explanation: string; action?: 'reconnect' | 'settings' | 'edit' | 'data'; fix?: { nodeId: string; label: string; changes: Record<string, string>; summary: string }; costUsd: number }
export interface RuleRow { id: string; text: string; enabled: boolean; created_at: string; rule: { summary: string; effect?: 'block' | 'approve'; actions: string[]; objects: string[]; days: number[]; hours: { from: number; to: number } | null; timezone: string; when: { field: string; operator: string; value: string }[] } }
export interface RegressionResult { checked: number; same: number; gone: number; changed: { runId: string; label: string; before: string; after: string }[]; costUsd: number }
export interface ChatMsg { role: 'user' | 'assistant'; text: string; options?: string[]; draft?: Draft }
export interface ChatReply { reply: string; question?: string; options?: string[]; request?: string; draft?: Draft; costUsd: number }
export interface PreviewRow {
  recordId: string; label: string; status: 'done' | 'error'; result: string; error?: string;
  wouldDo: { action: string; detail: unknown }[];
  decisions: { step: string; nodeId: string; value: string; input: string; categories: string[]; examplesUsed: number }[]; costUsd: number;
}
export interface Preview { object: string; rows: PreviewRow[]; totalCostUsd: number; avgCostUsd: number }
export type VizFormat = 'currency' | 'number' | 'percent' | 'days';
export interface Kpi { id: string; label: string; value: number; previous?: number; format: VizFormat; goodWhen: 'up' | 'down'; hint?: string }
export interface ChartData { id: string; title: string; kind: 'bar' | 'line'; format: VizFormat; data: { label: string; value: number }[] }
export interface ListData { id: string; title: string; columns: string[]; rows: (string | number)[][]; fix?: string; note?: string }
export interface Insights { periodDays: number; currency: string; generatedAt: string; sections: { id: string; title: string; kpis: Kpi[]; charts: ChartData[]; lists: ListData[] }[] }
export interface Briefing { headline: string; highlights: { title: string; detail: string; tone: 'good' | 'watch' | 'bad' }[]; actions: { title: string; detail: string }[]; costUsd: number; reused: boolean }
export interface Answer {
  title: string; question: string; soql: string; chart: 'bar' | 'line' | 'table' | 'number'; labelKey: string; valueKey: string;
  explanation: string; columns: string[]; rows: Record<string, unknown>[]; costUsd?: number;
}
export interface Tile extends Answer { id: string; label_key: string; value_key: string; error?: string }
export type ChartKind = 'kpi' | 'bar' | 'column' | 'line' | 'area' | 'stacked' | 'multiline' | 'table';
export type DashRange = 'all' | 'THIS_MONTH' | 'LAST_MONTH' | 'THIS_QUARTER' | 'LAST_QUARTER' | 'THIS_YEAR' | 'LAST_YEAR' | 'LAST_N_DAYS:30' | 'LAST_N_DAYS:90' | 'LAST_N_DAYS:365';
export interface TileSpec {
  id?: string; title: string; question: string; soql: string; chart: ChartKind; label_key: string; series_key: string; value_key: string;
  format: 'currency' | 'number' | 'percent'; date_field: string; drill_soql: string; size: 'third' | 'half' | 'full';
}
export interface TileData extends TileSpec { columns: string[]; rows: Record<string, unknown>[]; error?: string }
export interface DashDraft { name: string; description: string; questions: string[]; warnings: string[]; costUsd: number; tiles: TileData[] }
export interface DashSummary { id: string; name: string; description: string; updated_at: string; tiles: number }
export interface Dashboard { id: string; name: string; description: string; prompt: string; range: DashRange; tiles: TileData[] }
export interface WorkflowRow { id: string; name: string; graph: Workflow; updated_at: string; sf_flow_name?: string | null; sf_deployed_at?: string | null; live?: boolean; live_since?: string | null; watch_error?: string | null; paused_reason?: string | null; realtime?: boolean; allowed_fields?: Record<string, string[]> }
export interface Settings {
  callbackUrl: string; sfClientId: string; sfLoginUrl: string;
  sfClientSecret: { set: boolean }; anthropicKey: { set: boolean }; dailyBudgetUsd: string; anthropicWorkspaceId: string; aiCacheHours: string;
  maskPii?: string; maskFields?: string; maxAiCalls?: string; maxToolCalls?: string; maxTokens?: string; retentionDays?: string;
  actAsPerson?: string; memoryEnabled?: string; aiReady?: boolean;
  aiProvider?: string; providerKey?: { set: boolean }; aiBaseUrl?: string; aiModel?: string; aiFastModel?: string; aiPriceIn?: string; aiPriceOut?: string;
  auditInSalesforce?: string; alertEmails?: string; autoPauseAfter?: string;
  twilioSid?: string; twilioToken?: { set: boolean }; twilioSms?: string; twilioWhatsapp?: string;
}

export interface Me { id: string; email: string; accountName: string; role: string; platformAdmin?: boolean }
export type PlanId = 'basic' | 'plus' | 'pro' | 'promax';
export interface PlanSummary {
  plan: PlanId; name: string; trialEndsAt: string | null; trialEnded: boolean; requestedPlan: PlanId | null; features: string[];
  limits: { orgs: number | null; users: number | null; liveAgents: number | null; assistants: number | null };
  usage: { orgs: number; users: number; liveAgents: number; assistants: number };
}
export interface BillingStatus {
  configured: boolean; intervals: { plus: { month: boolean; year: boolean }; pro: { month: boolean; year: boolean } };
  subscription: { plan: PlanId | null; interval: 'month' | 'year' | null; status: string; amountCents: number | null; currency: string | null; renewsAt: string | null; cancelAtPeriodEnd: boolean; purchasedBy: string | null; startedAt: string | null } | null;
}
export type Stage = 'trial' | 'expired' | 'paying' | 'past_due' | 'churned' | 'comped';
export type Health = 'active' | 'quiet' | 'at_risk';
export interface AttentionItem { id: string; name: string; owner: string | null; why: string }
export interface AdminOverview {
  billingConfigured: boolean;
  kpis: {
    workspaces: { value: number; sub: string; change: number; changeLabel: string };
    mrr: { value: number; arr: number; paying: number; pastDue: number };
    trials: { value: number; ending: number; expired: number };
    people: { value: number; active7: number; change: number };
    ai: { value: number; runs: number; change: number };
    revenue: { value: number; change: number };
    requests: number;
  };
  stages: Record<Stage, number>; plans: Record<PlanId, number>;
  funnel: { step: string; n: number }[];
  attention: { trialsEnding: AttentionItem[]; paymentFailed: AttentionItem[]; upgradeAsks: AttentionItem[]; churnRisk: AttentionItem[]; disconnected: AttentionItem[] };
  series: { day: string; signups: number }[];
}
export interface AdminAccount {
  id: string; name: string; plan: PlanId; trialEndsAt: string | null; requestedPlan: PlanId | null; planSetBy: string | null; createdAt: string; tags: string[]; staffOwner: string | null;
  orgs: number; orgIssue: boolean; users: number; owner: string | null; lastActive: string | null; liveAgents: number; everLive: boolean; aiCost30: number; notes: number;
  subStatus: string | null; subInterval: string | null; subAmountCents: number | null; renewsAt: string | null; purchasedBy: string | null; cancelAtPeriodEnd: boolean | null;
  stage: Stage; health: Health; mrr: number;
}
export interface TimelineItem { at: string; kind: 'person' | 'org' | 'plan' | 'billing' | 'request' | 'note' | 'activity'; text: string; by?: string | null; detail?: string | null }
export interface AdminAccountDetail {
  account: AdminAccount;
  plan: PlanSummary;
  members: { email: string; role: string; createdAt: string; lastLoginAt: string | null }[];
  invites: { email: string; role: string; invitedBy: string | null; expiresAt: string }[];
  orgs: { username: string | null; url: string; status: string; message: string | null; usePackage: boolean; connectedAt: string }[];
  subscription: (NonNullable<BillingStatus['subscription']> & { customerId: string | null }) | null;
  payments: { type: string; plan: string | null; amountCents: number | null; currency: string | null; invoiceUrl: string | null; detail: string | null; createdAt: string }[];
  planHistory: { from: string | null; to: string; by: string; reason: string | null; createdAt: string }[];
  requests: { id: number; topic: string; source: string; status: string; message: string | null; createdAt: string }[];
  notes: { id: number; author: string; text: string; createdAt: string }[];
  activity: { user: string | null; action: string; target: string | null; createdAt: string }[];
  timeline: TimelineItem[];
  usage30: { runs: number; cost: number };
}
export interface AdminRevenue {
  mrr: number; arr: number; paying: number; billingConfigured: boolean;
  byMonth: { month: string; cents: number; started: number; canceled: number }[];
  subscriptions: { id: string; name: string; plan: PlanId; status: string; interval: string | null; amountCents: number | null; mrr: number; renewsAt: string | null; purchasedBy: string | null; cancelAtPeriodEnd: boolean | null }[];
}
export interface StaffLogItem { at: string; by: string | null; accountId: string | null; accountName: string | null; what: string; detail: string | null }
export interface AiKey {
  id: string; label: string; provider: 'anthropic' | 'openai' | 'gemini' | 'compatible'; hint: string; baseUrl: string | null; model: string | null; fastModel: string | null;
  priceIn: number | null; priceOut: number | null; workspaceId: string | null; primary: boolean; backup: boolean; sort: number;
  lastTest: { at: string; ok: boolean; ms: number; model: string } | null; lastError: { at: string; message: string } | null; lastUsedAt: string | null; createdAt: string;
}
export interface AiKeyInput { label: string; provider: AiKey['provider']; key: string; baseUrl?: string; model?: string; fastModel?: string; priceIn?: number; priceOut?: number; workspaceId?: string }
export interface SampleStatus { loaded: boolean; counts: Record<string, number>; loadedAt: string | null; allowed: boolean | null; orgKind: string | null }
export interface AdminUser { id: string; email: string; role: string; createdAt: string; lastLoginAt: string | null; accountId: string; accountName: string; plan: PlanId }
export interface AdminPayment { id: number; type: string; plan: string | null; amountCents: number | null; currency: string | null; invoiceUrl: string | null; detail: string | null; createdAt: string; accountId: string | null; accountName: string | null }
export interface AdminRequest { id: number; name: string; email: string; company: string; size: string | null; message: string | null; topic: string; source: string; status: string; notes: string | null; handledBy: string | null; assignedTo: string | null; createdAt: string; updatedAt: string | null; accountId: string | null; accountName: string | null }
export interface PlatformAccount { id: string; name: string; plan: PlanId; trialEndsAt: string | null; requestedPlan: PlanId | null; planSetBy: string | null; createdAt: string; orgs: number; users: number; owner: string | null }
export interface TeamUser { id: string; email: string; role: string; createdAt: string; lastLoginAt: string | null }
export interface TeamInvite { id: string; email: string; role: string; invitedBy: string | null; expiresAt: string; createdAt: string }
export interface RecordChange {
  id: number; run_id: string; op: 'create' | 'update' | 'delete'; object: string; record_id: string;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; undoable: boolean;
  undone_at: string | null; undone_by: string | null; undo_result: string | null; created_at: string; agent_name: string | null;
}
export interface UndoReport { restored: number; deleted: number; recovered: number; skipped: { recordId: string; object: string; why: string }[]; failed: { recordId: string; object: string; error: string }[] }
export interface Opportunity { id: string; title: string; area: string; evidence: string; volume: number; minutesEach: number; hoursPerMonth: number; valuePerMonth: number; request: string; compareFields?: string[] }
export interface Agreement { checked: number; matched: number; rate: number | null; examples: { recordId: string; field: string; agent: string; team: string; same: boolean }[] }
export interface Proof {
  workflowId: string; name: string; summary: string[]; estimateUsd: number; warnings: string[]; replayed: number; ok: number;
  rows: { recordId: string; label: string; status: string; error?: string; wouldDo: { action: string; detail: unknown }[] }[];
  agreement: Agreement | null; agreementBefore?: Agreement | null; learned?: number; costUsd: number; monthlyCostUsd: number; hoursPerMonth: number; valuePerMonth: number;
}
export interface Discovery { opportunities: Opportunity[]; totalHours: number; hourlyRate: number; checked: number; scannedAt: string; builds: Record<string, { opportunity: string; workflowId: string | null; proof: Proof; name: string | null; live: boolean | null }> }
export interface XAutomation { kind: 'flow' | 'process' | 'workflow' | 'trigger'; name: string; label: string; object: string; event: string; timing: string; writes: { object: string; fields: string[] }[]; creates: string[]; steps: number; actions: string[]; order: number | null; lastModified: string | null }
export interface XFinding { severity: 'high' | 'medium' | 'low'; kind: string; object: string; title: string; detail: string; automations: string[] }
export interface Xray { automations: XAutomation[]; findings: XFinding[]; objects: { object: string; count: number; kinds: Record<string, number>; rules: number; findings: number }[]; score: number; scannedAt: string; flowsRead: number; flowsSkipped: number }
export interface Forecast { perRunUsd: number; perRunBasis: 'actual' | 'estimate'; runsPerMonth: number; runsBasis: string; monthlyUsd: number; capUsd: number | null; spentThisMonthUsd: number; suggestedCapUsd: number }
export interface TrustFacts {
  ai: { provider: string; calls30d: number; maskedValues30d: number };
  masking: { on: boolean; extraFields: string[] };
  retentionDays: number;
  limits: { aiCalls: number; toolCalls: number; tokens: number; dailyBudgetUsd: string };
  agents: { total: number; live: number; liveWriting: number; liveWritingAsking: number; capped: number };
  rules: number; changes30d: number; undone30d: number; team: Record<string, number>; alerts: boolean;
  memory?: { on: boolean; team: number; personal: number; recordNotes: number };
  salesforce: { scopes: string[]; orgs: { id: string; username: string | null; url: string; status: string; connectedAt: string }[] };
}
export interface AiCallRow { id: number; createdAt: string; provider: string; model: string; maskedValues: number; inputTokens: number; outputTokens: number; costUsd: number; ms: number | null; error: string | null; runId: string | null; purpose: string }
export interface AiCallDetail { id: number; createdAt: string; provider: string; model: string; maskedValues: number; error: string | null; request: { system?: unknown; messages: { role: string; content: unknown }[]; tools: string[] }; response: { stop?: string; content: unknown } | null }
export interface ActivityRow { id: number; user: string | null; action: string; target: string | null; ip: string | null; createdAt: string }
export interface Remembered { kind: 'personal' | 'team' | 'record'; text: string; id?: string; recordId?: string }
export interface Conversation { id: string; title: string; channel: 'app' | 'salesforce'; recordId: string | null; agentId: string | null; agentName: string | null; updatedAt: string; messages: number }
export interface MemoryItem { id: string; scope: 'personal' | 'team'; owner: string | null; text: string; source: string; createdBy: string | null; uses: number; lastUsedAt: string | null; createdAt: string }
export interface RecordNote { id: number; tenantId: string; recordId: string; note: string; author: string | null; createdAt: string }
export interface Team { me: string; canManage: boolean; users: TeamUser[]; invites: TeamInvite[] }
export interface Alert { id: string; kind: string; title: string; body: string; tenantId: string | null; workflowId: string | null; readAt: string | null; createdAt: string }

export interface UsageSummary {
  runs: number; costUsd: number; budgetUsd: number | null; cacheHitRate: number | null;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

export const api = {
  usage: () => req<UsageSummary>('GET', '/api/usage'),
  startOAuth: (b: { sandbox?: boolean; domain?: string; clientId?: string; clientSecret?: string }) => req<{ url: string }>('POST', '/api/oauth/start', b),
  me: () => req<Me>('GET', '/api/auth/me'),
  login: (email: string, password: string) => req('POST', '/api/auth/login', { email, password }),
  signup: (b: { accountName: string; email: string; password: string; plan?: string }) => req('POST', '/api/auth/signup', b),
  forgot: (email: string) => req('POST', '/api/auth/forgot', { email }),
  resetPassword: (token: string, password: string) => req('POST', '/api/auth/reset', { token, password }),
  invite: (token: string) => req<{ email: string; role: string; invitedBy: string | null; accountName: string }>('GET', `/api/auth/invite/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, password: string) => req('POST', '/api/auth/accept', { token, password }),
  changePassword: (current: string, password: string) => req('POST', '/api/auth/password', { current, password }),
  team: () => req<Team>('GET', '/api/team'),
  plan: () => req<PlanSummary>('GET', '/api/plan'),
  requestUpgrade: (plan: PlanId, note?: string) => req('POST', '/api/plan/request', { plan, note }),
  platformAccounts: () => req<PlatformAccount[]>('GET', '/api/platform/accounts'),
  billing: () => req<BillingStatus>('GET', '/api/billing'),
  checkout: (plan: 'plus' | 'pro', interval: 'month' | 'year') => req<{ url: string }>('POST', '/api/billing/checkout', { plan, interval }),
  billingPortal: () => req<{ url: string }>('POST', '/api/billing/portal', {}),
  adminOverview: () => req<AdminOverview>('GET', '/api/platform/overview'),
  adminAccounts: () => req<AdminAccount[]>('GET', '/api/platform/accounts'),
  adminAccount: (id: string) => req<AdminAccountDetail>('GET', `/api/platform/accounts/${id}`),
  adminSetPlan: (id: string, plan: PlanId, reason?: string, trialDays?: number) => req('PUT', `/api/platform/accounts/${id}/plan`, { plan, reason, trialDays }),
  adminExtendTrial: (id: string, days: number) => req('POST', `/api/platform/accounts/${id}/trial`, { days }),
  adminUsers: () => req<AdminUser[]>('GET', '/api/platform/users'),
  adminPayments: () => req<AdminPayment[]>('GET', '/api/platform/payments'),
  adminRequests: () => req<AdminRequest[]>('GET', '/api/platform/requests'),
  adminUpdateRequest: (id: number, b: { status?: string; notes?: string; assignedTo?: string | null }) => req('PUT', `/api/platform/requests/${id}`, b),
  adminRevenue: () => req<AdminRevenue>('GET', '/api/platform/revenue'),
  adminSearch: (q: string) => req<{ workspaces: { id: string; name: string; plan: PlanId; owner: string | null }[]; users: { email: string; role: string; accountId: string; accountName: string }[] }>('GET', `/api/platform/search?q=${encodeURIComponent(q)}`),
  adminStaff: () => req<string[]>('GET', '/api/platform/staff'),
  adminStaffLog: () => req<StaffLogItem[]>('GET', '/api/platform/staff-log'),
  adminIntegrations: () => req<{ stripe: boolean; slack: boolean }>('GET', '/api/platform/integrations'),
  adminEmail: () => req<{ configured: boolean; from: string; keyHint: string | null }>('GET', '/api/platform/email'),
  adminSetEmail: (b: { resendKey?: string; mailFrom?: string }) => req<{ ok: true }>('PUT', '/api/platform/email', b),
  adminTestEmail: (to: string) => req<{ ok: boolean; error?: string }>('POST', '/api/platform/email/test', { to }),
  adminSetMeta: (id: string, b: { tags?: string[]; staffOwner?: string | null }) => req('PUT', `/api/platform/accounts/${id}/meta`, b),
  adminAddNote: (id: string, text: string) => req<{ id: number }>('POST', `/api/platform/accounts/${id}/notes`, { text }),
  adminDeleteNote: (id: number) => req('DELETE', `/api/platform/notes/${id}`),
  setAccountPlan: (id: string, plan: PlanId, trialDays?: number) => req('PUT', `/api/platform/accounts/${id}/plan`, { plan, trialDays }),
  conversations: (t: string, agentId?: string) => req<Conversation[]>('GET', `/api/tenants/${t}/conversations${agentId ? `?agentId=${agentId}` : ''}`),
  conversation: (t: string, id: string) => req<Conversation & { messages: { role: 'user' | 'assistant'; text: string; createdAt: string }[] }>('GET', `/api/tenants/${t}/conversations/${id}`),
  deleteConversation: (t: string, id: string) => req('DELETE', `/api/tenants/${t}/conversations/${id}`),
  memories: () => req<{ on: boolean; canTeam: boolean; memories: MemoryItem[]; notes: RecordNote[] }>('GET', '/api/memories'),
  addMemory: (text: string, scope: 'personal' | 'team') => req<{ id: string }>('POST', '/api/memories', { text, scope }),
  updateMemory: (id: string, text: string) => req('PUT', `/api/memories/${id}`, { text }),
  deleteMemory: (id: string) => req('DELETE', `/api/memories/${id}`),
  deleteRecordNote: (id: number) => req('DELETE', `/api/memories/notes/${id}`),
  trust: () => req<TrustFacts>('GET', '/api/trust'),
  aiCalls: () => req<AiCallRow[]>('GET', '/api/trust/ai-calls'),
  aiCall: (id: number) => req<AiCallDetail>('GET', `/api/trust/ai-calls/${id}`),
  activity: () => req<ActivityRow[]>('GET', '/api/trust/activity'),
  deleteWorkspace: (confirm: string) => req<{ deleted: boolean }>('POST', '/api/account/delete', { confirm }),
  forecast: (t: string, id: string) => req<Forecast>('GET', `/api/tenants/${t}/workflows/${id}/forecast`),
  setCap: (t: string, id: string, capUsd: number | null) => req<Forecast>('PUT', `/api/tenants/${t}/workflows/${id}/cap`, { capUsd }),
  xray: (t: string) => req<Xray | null>('GET', `/api/tenants/${t}/xray`),
  scanXray: (t: string) => req<Xray>('POST', `/api/tenants/${t}/xray/scan`, {}),
  explainObject: (t: string, object: string) => req<{ object: string; summary: string; risks: string; replacement: string; costUsd: number }>('POST', `/api/tenants/${t}/xray/explain`, { object }),
  draftReplacement: (t: string, request: string) => req<{ workflowId: string; name: string; summary: string[]; warnings: string[]; costUsd: number }>('POST', `/api/tenants/${t}/xray/replace`, { request, timezone: localTz() }),
  discovery: (t: string) => req<Discovery | null>('GET', `/api/tenants/${t}/discover`),
  scanOrg: (t: string) => req<Discovery>('POST', `/api/tenants/${t}/discover/scan`, {}),
  prove: (t: string, id: string) => req<Proof>('POST', `/api/tenants/${t}/discover/${id}/prove`, { timezone: localTz() }),
  learnFromTeam: (t: string, id: string) => req<Proof>('POST', `/api/tenants/${t}/discover/${id}/learn`, {}),
  changes: (t: string, q: { runId?: string; workflowId?: string; since?: string }) => req<{ changes: RecordChange[]; outside: { runId: string; label: string }[] }>('GET', `/api/tenants/${t}/changes?${new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][])}`),
  undo: (t: string, b: { runId?: string; workflowId?: string; since?: string; changeIds?: number[] }) => req<UndoReport>('POST', `/api/tenants/${t}/undo`, b),
  tests: (t: string, a: string) => req<{ tests: AssistantTest[]; runs: TestRun[] }>('GET', `/api/tenants/${t}/agents/${a}/tests`),
  recentQuestions: (t: string, a: string) => req<{ question: string; answer: string }[]>('GET', `/api/tenants/${t}/agents/${a}/tests/recent`),
  saveTest: (t: string, a: string, b: Omit<AssistantTest, 'id'>, id?: string) => req<{ id: string }>(id ? 'PUT' : 'POST', `/api/tenants/${t}/agents/${a}/tests${id ? `/${id}` : ''}`, b),
  deleteTest: (t: string, a: string, id: string) => req('DELETE', `/api/tenants/${t}/agents/${a}/tests/${id}`),
  runTests: (t: string, a: string, channel: 'internal' | 'website') => req<{ id: string }>('POST', `/api/tenants/${t}/agents/${a}/tests/run`, { channel }),
  inviteUser: (email: string, role: string) => req<{ id: string; link: string; emailed: boolean }>('POST', '/api/team/invites', { email, role }),
  cancelInvite: (id: string) => req('DELETE', `/api/team/invites/${id}`),
  setUserRole: (id: string, role: string) => req('PUT', `/api/team/users/${id}`, { role }),
  removeUser: (id: string) => req('DELETE', `/api/team/users/${id}`),
  resetLink: (id: string) => req<{ link: string; emailed: boolean }>('POST', `/api/team/users/${id}/reset-link`, {}),
  alerts: () => req<{ alerts: Alert[]; unread: number }>('GET', '/api/alerts'),
  readAlerts: () => req('POST', '/api/alerts/read', {}),
  logout: () => req('POST', '/api/auth/logout', {}),
  settings: () => req<Settings>('GET', '/api/settings'),
  saveSettings: (b: Record<string, string>) => req('PUT', '/api/settings', b),
  tenants: () => req<Tenant[]>('GET', '/api/tenants'),
  setup: (id: string) => req<{ ok: boolean }>('POST', `/api/tenants/${id}/setup`, {}),
  provision: (id: string) => req<{ ok: boolean }>('POST', `/api/tenants/${id}/provision`, {}),
  removeTenant: (id: string) => req('DELETE', `/api/tenants/${id}`),
  tools: () => req<ToolInfo[]>('GET', '/api/tools'),
  agents: (t: string) => req<Agent[]>('GET', `/api/tenants/${t}/agents`),
  createAgent: (t: string, a: Omit<Agent, 'id'>) => req<{ id: string }>('POST', `/api/tenants/${t}/agents`, a),
  updateAgent: (t: string, a: Agent) => req('PUT', `/api/tenants/${t}/agents/${a.id}`, a),
  deleteAgent: (t: string, id: string) => req('DELETE', `/api/tenants/${t}/agents/${id}`),
  run: (t: string, id: string, input: string, history?: { role: 'user' | 'assistant'; text: string }[], conversationId?: string | null) =>
    req<{ runId: string; output: string; conversationId: string | null; remembered: Remembered[] }>('POST', `/api/tenants/${t}/agents/${id}/run`, { input, history, conversationId }),
  publicChat: (t: string, agentId: string) => req<PublicChat>('GET', `/api/tenants/${t}/agents/${agentId}/public`),
  setPublicChat: (t: string, agentId: string, b: Omit<PublicChat, 'snippet' | 'sms'> & { sms?: boolean }) => req<PublicChat>('PUT', `/api/tenants/${t}/agents/${agentId}/public`, b),
  sfPages: (t: string, object?: string) => req<{ utilityBars: SfPage[]; recordPages: SfPage[] }>('GET', `/api/tenants/${t}/salesforce/pages${object ? `?object=${encodeURIComponent(object)}` : ''}`),
  addToUtilityBar: (t: string, pageId: string) => req<{ changed: boolean; label: string }>('POST', `/api/tenants/${t}/salesforce/pages/utility`, { pageId }),
  addToRecordPage: (t: string, object: string, pageId?: string) => req<{ changed: boolean; id: string; label: string; activateUrl: string | null }>('POST', `/api/tenants/${t}/salesforce/pages/record`, { object, pageId }),
  impact: (t: string, days: number) => req<Impact>('GET', `/api/tenants/${t}/impact?days=${days}`),
  saveImpactAssumptions: (a: ImpactAssumptions) => req('PUT', '/api/impact/assumptions', a),
  webhook: (t: string, id: string) => req<{ url: string; secret: string }>('GET', `/api/tenants/${t}/workflows/${id}/webhook`),
  rotateWebhook: (t: string, id: string) => req<{ url: string; secret: string }>('POST', `/api/tenants/${t}/workflows/${id}/webhook/rotate`, {}),
  backfill: (t: string, id: string, days: number, limit: number) => req<{ queued: number; objects: { object: string; found: number }[] }>('POST', `/api/tenants/${t}/workflows/${id}/backfill`, { days, limit }),
  versions: (t: string, id: string) => req<{ id: number; name: string; savedBy: string | null; createdAt: string; steps: number }[]>('GET', `/api/tenants/${t}/workflows/${id}/versions`),
  restoreVersion: (t: string, id: string, vid: number) => req<{ name: string; graph: Workflow }>('POST', `/api/tenants/${t}/workflows/${id}/versions/${vid}/restore`, {}),
  exportAgent: (t: string, id: string) => req<{ format: string; name: string; graph: Workflow }>('GET', `/api/tenants/${t}/workflows/${id}/export`),
  importAgent: (t: string, b: { name: string; graph: Workflow }) => req<{ id: string; missing: string[] }>('POST', `/api/tenants/${t}/workflows/import`, b),
  copyAgent: (t: string, id: string, targetTenantId: string) => req<{ id: string; missing: string[] }>('POST', `/api/tenants/${t}/workflows/${id}/copy`, { targetTenantId }),
  setAllowedFields: (t: string, id: string, allowed: Record<string, string[]>) => req<{ allowed: Record<string, string[]> }>('PUT', `/api/tenants/${t}/workflows/${id}/allowed-fields`, { allowed }),
  draftWorkflow: (t: string, request: string, plan?: unknown) => req<Draft>('POST', `/api/tenants/${t}/workflows/draft`, { request, plan, timezone: localTz() }),
  suggestions: (t: string, refresh = false) => req<Suggestion[]>('GET', `/api/tenants/${t}/suggestions${refresh ? '?refresh=1' : ''}`),
  dismissSuggestion: (t: string, key: string) => req('POST', `/api/tenants/${t}/suggestions/${key}/dismiss`),
  backtest: (t: string, id: string) => req<BacktestResult>('POST', `/api/tenants/${t}/workflows/${id}/backtest`),
  agentHealth: (t: string) => req<AgentHealth[]>('GET', `/api/tenants/${t}/agent-health`),
  dropApproval: (t: string, id: string) => req<{ ok: boolean; graph: Workflow }>('POST', `/api/tenants/${t}/workflows/${id}/autonomy`, { approval: false }),
  diagnose: (t: string, runId: string) => req<Diagnosis>('POST', `/api/tenants/${t}/runs/${runId}/diagnose`),
  applyFix: (t: string, id: string, nodeId: string, changes: Record<string, string>) => req('POST', `/api/tenants/${t}/workflows/${id}/apply-fix`, { nodeId, changes }),
  knowledge: () => req<KnowledgeDoc[]>('GET', '/api/knowledge'),
  addKnowledge: (b: { fileName?: string; data?: string; title?: string; text?: string }) => req<{ id: string; chunks: number }>('POST', '/api/knowledge', b),
  deleteKnowledge: (id: string) => req('DELETE', `/api/knowledge/${id}`),
  searchKnowledge: (query: string) => req<KnowledgeHit[]>('POST', '/api/knowledge/search', { query }),
  knowledgeSources: () => req<KnowledgeSource[]>('GET', '/api/knowledge/sources'),
  addKnowledgeSource: (b: { tenantId: string; kind: 'articles' | 'library'; library?: string }) => req<{ id: string; result: string; ok: boolean }>('POST', '/api/knowledge/sources', b),
  syncKnowledgeSource: (id: string) => req<{ id: string; result: string; ok: boolean }>('POST', `/api/knowledge/sources/${id}/sync`, {}),
  removeKnowledgeSource: (id: string) => req('DELETE', `/api/knowledge/sources/${id}`),
  recordSuggestions: (t: string) => req<RecordSuggestion[]>('GET', `/api/tenants/${t}/record-suggestions`),
  markSuggestion: (t: string, id: string, status: RecordSuggestion['status']) => req('POST', `/api/tenants/${t}/record-suggestions/${id}`, { status }),
  rules: (t: string) => req<RuleRow[]>('GET', `/api/tenants/${t}/rules`),
  addRule: (t: string, text: string) => req<RuleRow>('POST', `/api/tenants/${t}/rules`, { text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  toggleRule: (t: string, id: string, enabled: boolean) => req('PATCH', `/api/tenants/${t}/rules/${id}`, { enabled }),
  deleteRule: (t: string, id: string) => req('DELETE', `/api/tenants/${t}/rules/${id}`),
  regression: (t: string, id: string, graph: Workflow) => req<RegressionResult>('POST', `/api/tenants/${t}/workflows/${id}/regression`, { graph }),
  setRealtime: (t: string, id: string, on: boolean) => req<{ realtime: boolean }>('POST', `/api/tenants/${t}/workflows/${id}/realtime`, { on }),
  builderChat: (t: string, messages: { role: 'user' | 'assistant'; text: string }[], plan?: unknown) => req<ChatReply>('POST', `/api/tenants/${t}/builder/chat`, { messages, plan, timezone: localTz() }),
  previewWorkflow: (t: string, id: string, limit = 10) => req<Preview>('POST', `/api/tenants/${t}/workflows/${id}/preview`, { limit }),
  feedback: (t: string, id: string, b: { nodeId: string; input: string; label: string; source: 'correction' | 'confirmed' }) =>
    req<{ ok: boolean; examples: number }>('POST', `/api/tenants/${t}/workflows/${id}/feedback`, b),
  deployWorkflow: (t: string, id: string) => req<{ flowName: string; object: string }>('POST', `/api/tenants/${t}/workflows/${id}/deploy`, {}),
  undeployWorkflow: (t: string, id: string) => req<{ ok: boolean }>('DELETE', `/api/tenants/${t}/workflows/${id}/deploy`),
  insights: (t: string, period: number, refresh = false) => req<Insights>('GET', `/api/tenants/${t}/insights?period=${period}${refresh ? '&refresh=1' : ''}`),
  briefing: (t: string, period: number) => req<Briefing>('POST', `/api/tenants/${t}/insights/summary`, { period }),
  ask: (t: string, question: string) => req<Answer>('POST', `/api/tenants/${t}/insights/ask`, { question }),
  tiles: (t: string) => req<Tile[]>('GET', `/api/tenants/${t}/insights/tiles`),
  pinTile: (t: string, a: Answer) => req<{ id: string }>('POST', `/api/tenants/${t}/insights/tiles`, { title: a.title, question: a.question, soql: a.soql, chart: a.chart, labelKey: a.labelKey, valueKey: a.valueKey }),
  unpinTile: (t: string, id: string) => req('DELETE', `/api/tenants/${t}/insights/tiles/${id}`),
  dashboards: (t: string) => req<DashSummary[]>('GET', `/api/tenants/${t}/dashboards`),
  draftDashboard: (t: string, prompt: string, range: DashRange, single = false) => req<DashDraft>('POST', `/api/tenants/${t}/dashboards/draft`, { prompt, range, single }),
  dashboard: (t: string, id: string, range: DashRange) => req<Dashboard>('GET', `/api/tenants/${t}/dashboards/${id}?range=${encodeURIComponent(range)}`),
  createDashboard: (t: string, b: { name: string; description: string; prompt: string; tiles: TileSpec[] }) => req<{ id: string }>('POST', `/api/tenants/${t}/dashboards`, b),
  saveDashboard: (t: string, id: string, b: { name: string; description: string; tiles: TileSpec[] }) => req('PUT', `/api/tenants/${t}/dashboards/${id}`, b),
  deleteDashboard: (t: string, id: string) => req('DELETE', `/api/tenants/${t}/dashboards/${id}`),
  runTiles: (t: string, tiles: TileSpec[], range: DashRange) => req<TileData[]>('POST', `/api/tenants/${t}/dashboards/run`, { tiles, range }),
  drillTile: (t: string, tile: TileSpec, label: string, range: DashRange) => req<{ columns: string[]; rows: Record<string, unknown>[] }>('POST', `/api/tenants/${t}/dashboards/drill`, { tile, label, range }),
  setLive: (t: string, id: string, on: boolean) => req<{ live: boolean; object?: string; event?: string }>('POST', `/api/tenants/${t}/workflows/${id}/live`, { on }),
  setPackage: (t: string, on: boolean) => req('POST', `/api/tenants/${t}/package`, { on }),
  sampleStatus: (t: string) => req<SampleStatus>('GET', `/api/tenants/${t}/sample-data`),
  loadSample: (t: string) => req<{ counts: Record<string, number>; failures: string[] }>('POST', `/api/tenants/${t}/sample-data`),
  removeSample: (t: string) => req<{ removed: number; failures: string[] }>('DELETE', `/api/tenants/${t}/sample-data`),
  mySalesforce: (t: string) => req<{ required: boolean; linked: boolean; sfUsername: string | null; linkedAt: string | null }>('GET', `/api/tenants/${t}/my-salesforce`),
  linkMySalesforce: (t: string) => req<{ url: string }>('POST', `/api/tenants/${t}/my-salesforce/link`),
  unlinkMySalesforce: (t: string) => req<{ ok: true }>('DELETE', `/api/tenants/${t}/my-salesforce`),
  personLinks: (t: string) => req<{ email: string; role: string; sfUsername: string | null; linkedAt: string | null }[]>('GET', `/api/tenants/${t}/person-links`),
  chatApprovals: () => req<{ slack: { available: boolean; connected: boolean; team: string | null; channel: string | null; by: string | null }; teams: { connected: boolean; by: string | null } }>('GET', '/api/chat-approvals'),
  installSlack: () => req<{ url: string }>('POST', '/api/chat-approvals/slack/install'),
  setTeamsApprovals: (webhookUrl: string) => req<{ ok: true }>('PUT', '/api/chat-approvals/teams', { webhookUrl }),
  removeChatApprovals: (kind: 'slack' | 'teams') => req<{ ok: true }>('DELETE', `/api/chat-approvals/${kind}`),
  testChatApprovals: (kind: 'slack' | 'teams') => req<{ ok: boolean; error?: string }>('POST', '/api/chat-approvals/test', { kind }),
  aiKeys: () => req<{ keys: AiKey[]; platformDefault: boolean }>('GET', '/api/ai-keys'),
  addAiKey: (b: AiKeyInput & { makePrimary?: boolean }) => req<AiKey>('POST', '/api/ai-keys', b),
  updateAiKey: (id: string, b: Partial<AiKeyInput> & { backup?: boolean; sort?: number }) => req<AiKey>('PUT', `/api/ai-keys/${id}`, b),
  removeAiKey: (id: string) => req<{ ok: true }>('DELETE', `/api/ai-keys/${id}`),
  makePrimaryAiKey: (id: string) => req<{ ok: true }>('POST', `/api/ai-keys/${id}/primary`),
  testAiKey: (id: string) => req<{ ok: boolean; ms: number; model: string; reply?: string; error?: string }>('POST', `/api/ai-keys/${id}/test`),
  testNewAiKey: (b: Omit<AiKeyInput, 'label'>) => req<{ ok: boolean; ms: number; model: string; reply?: string; error?: string }>('POST', '/api/ai-keys/test', b),
  grantAccess: (t: string) => req<{ granted: number; total: number }>('POST', `/api/tenants/${t}/grant-access`),
  workflows: (t: string) => req<WorkflowRow[]>('GET', `/api/tenants/${t}/workflows`),
  createWorkflow: (t: string, b: { name: string; graph: Workflow }) => req<{ id: string }>('POST', `/api/tenants/${t}/workflows`, b),
  saveWorkflow: (t: string, id: string, b: { name: string; graph: Workflow }) => req('PUT', `/api/tenants/${t}/workflows/${id}`, b),
  deleteWorkflow: (t: string, id: string) => req('DELETE', `/api/tenants/${t}/workflows/${id}`),
  runWorkflow: (t: string, id: string, trigger: Record<string, unknown>) => req<RunResult>('POST', `/api/tenants/${t}/workflows/${id}/run`, trigger),
  cancelRun: (t: string, runId: string) => req('POST', `/api/tenants/${t}/runs/${runId}/cancel`),
  resumeRun: (t: string, runId: string) => req('POST', `/api/tenants/${t}/runs/${runId}/resume`),
  decide: (t: string, runId: string, approve: boolean, note?: string) => req<RunResult>('POST', `/api/tenants/${t}/runs/${runId}/decision`, { approve, note }),
  runs: (t: string, status?: string) => req<Run[]>('GET', `/api/tenants/${t}/runs${status ? `?status=${status}` : ''}`),
};
