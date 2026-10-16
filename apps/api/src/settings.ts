import { decrypt, encrypt } from './crypto.js';
import { pool } from './db.js';

// Credentials are entered from the UI and stored encrypted. Per-account values override the
// platform default (zero-uuid account), which in turn falls back to env vars.
const PLATFORM = '00000000-0000-0000-0000-000000000000';

export const SETTING_KEYS = {
  sfClientId: 'SF_CLIENT_ID',
  sfClientSecret: 'SF_CLIENT_SECRET',
  sfLoginUrl: 'SF_LOGIN_URL',
  anthropicKey: 'ANTHROPIC_API_KEY',
  anthropicWorkspaceId: 'ANTHROPIC_WORKSPACE_ID',
  dailyBudgetUsd: 'DAILY_AI_BUDGET_USD',
  aiCacheHours: 'AI_CACHE_HOURS',
  maskPii: 'MASK_PII',
  maskFields: 'MASK_FIELDS',
  maxAiCalls: 'MAX_AI_CALLS_PER_RUN',
  maxToolCalls: 'MAX_TOOL_CALLS_PER_RUN',
  maxTokens: 'MAX_TOKENS_PER_RUN',
  retentionDays: 'RUN_RETENTION_DAYS',
  aiProvider: 'AI_PROVIDER',
  providerKey: 'AI_PROVIDER_KEY',
  aiBaseUrl: 'AI_BASE_URL',
  aiModel: 'AI_MODEL',
  aiFastModel: 'AI_FAST_MODEL',
  aiPriceIn: 'AI_PRICE_IN',
  aiPriceOut: 'AI_PRICE_OUT',
  auditInSalesforce: 'AUDIT_IN_SALESFORCE',
  impactHourlyRate: 'IMPACT_HOURLY_RATE',
  impactMinutes: 'IMPACT_MINUTES',
  alertEmails: 'ALERT_EMAILS',
  autoPauseAfter: 'AUTO_PAUSE_AFTER',
} as const;

/** Settings shown as plain values in the UI (not secrets). */
export const PLAIN_SETTINGS: SettingName[] = ['sfClientId', 'sfLoginUrl', 'dailyBudgetUsd', 'anthropicWorkspaceId', 'aiCacheHours', 'maskPii', 'maskFields', 'maxAiCalls', 'maxToolCalls', 'maxTokens', 'retentionDays', 'aiProvider', 'aiBaseUrl', 'aiModel', 'aiFastModel', 'aiPriceIn', 'aiPriceOut', 'auditInSalesforce', 'impactHourlyRate', 'impactMinutes', 'alertEmails', 'autoPauseAfter'];
export type SettingName = keyof typeof SETTING_KEYS;

export async function getSetting(accountId: string, name: SettingName): Promise<string | undefined> {
  const { rows } = await pool.query(
    'select value_enc, account_id from settings where key = $1 and account_id in ($2,$3)',
    [name, accountId, PLATFORM],
  );
  const row = rows.find((r) => r.account_id === accountId) ?? rows[0];
  if (row) return decrypt(row.value_enc);
  return process.env[SETTING_KEYS[name]] || undefined;
}

export async function setSetting(accountId: string, name: SettingName, value: string): Promise<void> {
  if (!value) {
    await pool.query('delete from settings where key = $1 and account_id = $2', [name, accountId]);
    return;
  }
  await pool.query(
    `insert into settings (account_id, key, value_enc) values ($1,$2,$3)
     on conflict (account_id, key) do update set value_enc = excluded.value_enc, updated_at = now()`,
    [accountId, name, encrypt(value)],
  );
}

export async function getSfConfig(accountId: string) {
  const clientId = await getSetting(accountId, 'sfClientId');
  if (!clientId) throw new Error('Salesforce app is not configured. Add the Consumer Key in Settings.');
  return {
    clientId,
    clientSecret: (await getSetting(accountId, 'sfClientSecret')) ?? '',
    loginUrl: (await getSetting(accountId, 'sfLoginUrl')) ?? 'https://login.salesforce.com',
  };
}
