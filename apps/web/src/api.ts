async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('crmagents:unauthorized'));
  if (!res.ok) throw new Error(j.error ?? `Request failed (${res.status})`);
  return j as T;
}

import type { Workflow } from '@crmagents/shared';
export type { Workflow };
export interface Tenant {
  id: string; sf_org_id: string; sf_instance_url: string; sf_username: string | null;
  setup_status?: string; setup_message?: string | null; use_package?: boolean;
}
export interface KnowledgeDoc { id: string; title: string; fileName: string | null; kind: 'pdf' | 'docx' | 'text'; chars: number; chunks: number; createdBy: string | null; createdAt: string }
export interface KnowledgeHit { docId: string; title: string; heading: string; body: string; rank: number }
export interface RecordSuggestion {
  id: string; recordId: string; objectName: string; title: string; body: string; sources: { title: string; section: string }[];
  status: 'new' | 'helpful' | 'not_helpful' | 'dismissed'; agentName: string | null; decidedBy: string | null; createdAt: string;
}
export interface Agent { id: string; name: string; systemPrompt: string; tools: string[] }
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
export interface WorkflowRow { id: string; name: string; graph: Workflow; updated_at: string; sf_flow_name?: string | null; sf_deployed_at?: string | null; live?: boolean; live_since?: string | null; watch_error?: string | null; realtime?: boolean; allowed_fields?: Record<string, string[]> }
export interface Settings {
  callbackUrl: string; sfClientId: string; sfLoginUrl: string;
  sfClientSecret: { set: boolean }; anthropicKey: { set: boolean }; dailyBudgetUsd: string; anthropicWorkspaceId: string; aiCacheHours: string;
  maskPii?: string; maskFields?: string; maxAiCalls?: string; maxToolCalls?: string; maxTokens?: string; retentionDays?: string;
}

export interface Me { id: string; email: string; accountName: string; role: string }

export interface UsageSummary {
  runs: number; costUsd: number; budgetUsd: number | null; cacheHitRate: number | null;
  tokens: { input: number; cacheRead: number; cacheWrite: number; output: number };
}

export const api = {
  usage: () => req<UsageSummary>('GET', '/api/usage'),
  startOAuth: (b: { sandbox?: boolean; domain?: string; clientId?: string; clientSecret?: string }) => req<{ url: string }>('POST', '/api/oauth/start', b),
  me: () => req<Me>('GET', '/api/auth/me'),
  login: (email: string, password: string) => req('POST', '/api/auth/login', { email, password }),
  signup: (b: { accountName: string; email: string; password: string }) => req('POST', '/api/auth/signup', b),
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
  run: (t: string, id: string, input: string, history?: { role: 'user' | 'assistant'; text: string }[]) =>
    req<{ runId: string; output: string }>('POST', `/api/tenants/${t}/agents/${id}/run`, { input, history }),
  setAllowedFields: (t: string, id: string, allowed: Record<string, string[]>) => req<{ allowed: Record<string, string[]> }>('PUT', `/api/tenants/${t}/workflows/${id}/allowed-fields`, { allowed }),
  draftWorkflow: (t: string, request: string, plan?: unknown) => req<Draft>('POST', `/api/tenants/${t}/workflows/draft`, { request, plan }),
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
  recordSuggestions: (t: string) => req<RecordSuggestion[]>('GET', `/api/tenants/${t}/record-suggestions`),
  markSuggestion: (t: string, id: string, status: RecordSuggestion['status']) => req('POST', `/api/tenants/${t}/record-suggestions/${id}`, { status }),
  rules: (t: string) => req<RuleRow[]>('GET', `/api/tenants/${t}/rules`),
  addRule: (t: string, text: string) => req<RuleRow>('POST', `/api/tenants/${t}/rules`, { text, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  toggleRule: (t: string, id: string, enabled: boolean) => req('PATCH', `/api/tenants/${t}/rules/${id}`, { enabled }),
  deleteRule: (t: string, id: string) => req('DELETE', `/api/tenants/${t}/rules/${id}`),
  regression: (t: string, id: string, graph: Workflow) => req<RegressionResult>('POST', `/api/tenants/${t}/workflows/${id}/regression`, { graph }),
  setRealtime: (t: string, id: string, on: boolean) => req<{ realtime: boolean }>('POST', `/api/tenants/${t}/workflows/${id}/realtime`, { on }),
  builderChat: (t: string, messages: { role: 'user' | 'assistant'; text: string }[], plan?: unknown) => req<ChatReply>('POST', `/api/tenants/${t}/builder/chat`, { messages, plan }),
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
