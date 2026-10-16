import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Settings, type UsageSummary } from '../api';
import { Meter, Panel, Status, toast } from '../components/ui';

// AI & spending: the AI key, the daily budget and answer reuse. Secrets are write-only; a save bar appears on change.

const EMPTY = { sfClientId: '', sfClientSecret: '', sfLoginUrl: '', anthropicKey: '', dailyBudgetUsd: '', anthropicWorkspaceId: '', aiCacheHours: '', maskPii: '', maskFields: '', maxAiCalls: '', maxToolCalls: '', maxTokens: '', retentionDays: '' };

export function SettingsPage() {
  const [s, setS] = useState<Settings>();
  const [usage, setUsage] = useState<UsageSummary>();
  const [form, setForm] = useState(EMPTY);
  const [base, setBase] = useState(EMPTY);
  const [msg, setMsg] = useState('');
  const [saving, setSaving] = useState(false);

  const load = () => api.settings().then((x) => {
    setS(x);
    const f = { ...EMPTY, sfClientId: x.sfClientId, sfLoginUrl: x.sfLoginUrl, dailyBudgetUsd: x.dailyBudgetUsd ?? '', anthropicWorkspaceId: x.anthropicWorkspaceId ?? '', aiCacheHours: x.aiCacheHours ?? '',
      maskPii: x.maskPii ?? '', maskFields: x.maskFields ?? '', maxAiCalls: x.maxAiCalls ?? '', maxToolCalls: x.maxToolCalls ?? '', maxTokens: x.maxTokens ?? '', retentionDays: x.retentionDays ?? '' };
    setForm(f); setBase(f);
  });
  useEffect(() => { load().catch((e) => setMsg(e.message)); api.usage().then(setUsage).catch(() => {}); }, []);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(base), [form, base]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      // Secrets are only sent when typed, so a blank field never wipes a stored value.
      const body: Record<string, string> = { sfClientId: form.sfClientId, sfLoginUrl: form.sfLoginUrl, dailyBudgetUsd: form.dailyBudgetUsd.trim(), anthropicWorkspaceId: form.anthropicWorkspaceId.trim(), aiCacheHours: form.aiCacheHours.trim(),
        maskPii: form.maskPii, maskFields: form.maskFields.trim(), maxAiCalls: form.maxAiCalls.trim(), maxToolCalls: form.maxToolCalls.trim(), maxTokens: form.maxTokens.trim(), retentionDays: form.retentionDays.trim() };
      if (form.sfClientSecret) body.sfClientSecret = form.sfClientSecret;
      if (form.anthropicKey) body.anthropicKey = form.anthropicKey;
      await api.saveSettings(body);
      await load();
      setMsg('');
      toast('Settings saved');
    } catch (e) { setMsg((e as Error).message); }
    finally { setSaving(false); }
  };
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => { setMsg(''); setForm({ ...form, [k]: e.target.value }); };
  const budget = Number(form.dailyBudgetUsd || 2);

  return (
    <div className="smart-col">
      <Panel title="AI key">
        <div className="form">
          <div className="frow">
            <div className="flabel"><b>Anthropic API key</b><span>Stored encrypted and never shown again.</span></div>
            <div className="ffield">
              <div className="row" style={{ gap: 8 }}>
                <input id="ai-key" type="password" value={form.anthropicKey} onChange={set('anthropicKey')} placeholder={s?.anthropicKey?.set ? '•••••••• saved, type to replace' : 'sk-ant-…'} />
                {s?.anthropicKey?.set ? <Status tone="ok">Saved</Status> : <Status tone="warn">Missing</Status>}
              </div>
            </div>
          </div>
          <div className="frow">
            <div className="flabel"><b>Workspace ID</b><span>Only for user keys (sk-ant-usr-…). Find it in the Claude Console under Settings → Workspaces.</span></div>
            <div className="ffield"><input id="ai-ws" value={form.anthropicWorkspaceId} onChange={set('anthropicWorkspaceId')} placeholder="wrkspc_…" /></div>
          </div>
        </div>
      </Panel>

      <Panel title="Spending">
        <div className="form">
          <div className="frow">
            <div className="flabel"><b>Daily budget</b><span>AI steps pause once the workspace spends this much in 24 hours. Type "none" for no limit.</span></div>
            <div className="ffield">
              <div className="input-affix"><span>$</span><input id="ai-budget" value={form.dailyBudgetUsd} onChange={set('dailyBudgetUsd')} placeholder="2" inputMode="decimal" /></div>
              {usage && Number.isFinite(budget) && <><Meter value={usage.costUsd} max={budget} label="Spent today" /><span className="muted small">${usage.costUsd.toFixed(2)} spent in the last 24 hours</span></>}
            </div>
          </div>
          <div className="frow">
            <div className="flabel"><b>Reuse identical answers</b><span>When an AI step gets exactly the same input again, the earlier answer is reused at no cost. Steps that read live data are never reused. 0 turns it off.</span></div>
            <div className="ffield"><div className="input-affix"><input id="ai-cache" value={form.aiCacheHours} onChange={set('aiCacheHours')} placeholder="24" inputMode="numeric" /><span>hours</span></div>
              {usage?.cacheHitRate != null && <span className="muted small">{Math.round(usage.cacheHitRate * 100)}% of AI input was reused in the last 24 hours</span>}</div>
          </div>
        </div>
      </Panel>

      <Panel title="Privacy & limits">
        <div className="form">
          <div className="frow">
            <div className="flabel"><b>Hide personal data from the AI</b><span>Emails, phone numbers, card numbers, SSNs and IBANs are swapped for placeholders like [EMAIL_1] before anything goes to the AI. Salesforce updates still get the real values.</span></div>
            <div className="ffield">
              <label className="check"><input id="mask-on" type="checkbox" checked={form.maskPii !== 'off'} onChange={(e) => { setMsg(''); setForm({ ...form, maskPii: e.target.checked ? 'on' : 'off' }); }} /> {form.maskPii === 'off' ? 'Off: the AI sees data as it is' : 'On (recommended)'}</label>
            </div>
          </div>
          <div className="frow">
            <div className="flabel"><b>Other sensitive fields</b><span>Field API names to hide too, separated by commas.</span></div>
            <div className="ffield"><input id="mask-fields" value={form.maskFields} onChange={set('maskFields')} placeholder="e.g. Salary__c, MailingStreet, Date_of_Birth__c" disabled={form.maskPii === 'off'} /></div>
          </div>
          <div className="frow">
            <div className="flabel"><b>Limits per run</b><span>A run stops if it goes past any of these, so one agent can't run away with your budget.</span></div>
            <div className="ffield limits-row">
              <label>AI calls<div className="input-affix"><input id="lim-ai" value={form.maxAiCalls} onChange={set('maxAiCalls')} placeholder="40" inputMode="numeric" /></div></label>
              <label>Tool calls<div className="input-affix"><input id="lim-tools" value={form.maxToolCalls} onChange={set('maxToolCalls')} placeholder="60" inputMode="numeric" /></div></label>
              <label>Tokens<div className="input-affix"><input id="lim-tok" value={form.maxTokens} onChange={set('maxTokens')} placeholder="400000" inputMode="numeric" /></div></label>
            </div>
          </div>
          <div className="frow">
            <div className="flabel"><b>Keep run details for</b><span>After this, inputs, AI replies and tool results are cleared. Status, cost and timing stay. 0 keeps everything.</span></div>
            <div className="ffield"><div className="input-affix"><input id="retention" value={form.retentionDays} onChange={set('retentionDays')} placeholder="30" inputMode="numeric" /><span>days</span></div></div>
          </div>
        </div>
      </Panel>

      <details className="panel adv">
        <summary>Advanced: Salesforce login app</summary>
        <div className="panel-body form">
          <p className="muted small" style={{ margin: 0 }}>The app every org connects through. Callback URL: <code className="copy">{s?.callbackUrl}</code></p>
          <div className="frow"><div className="flabel"><b>Consumer Key</b></div><div className="ffield"><input id="sf-key" value={form.sfClientId} onChange={set('sfClientId')} placeholder="3MVG9…" /></div></div>
          <div className="frow"><div className="flabel"><b>Consumer Secret</b><span>Optional with PKCE.</span></div><div className="ffield"><input id="sf-secret" type="password" value={form.sfClientSecret} onChange={set('sfClientSecret')} placeholder={s?.sfClientSecret?.set ? '•••••••• saved, type to replace' : ''} /></div></div>
          <div className="frow"><div className="flabel"><b>Login URL</b></div><div className="ffield"><input id="sf-login" value={form.sfLoginUrl} onChange={set('sfLoginUrl')} placeholder="https://login.salesforce.com" /></div></div>
        </div>
      </details>

      {(dirty || msg) && (
        <div className="savebar" role="status">
          <span>{msg || 'You have unsaved changes'}</span>
          {dirty && <><button onClick={() => { setForm(base); setMsg(''); }}>Discard</button>
            <button className="primary" onClick={() => void save()} disabled={saving}>{saving ? <Loader2 size={15} className="spin" /> : null} Save changes</button></>}
        </div>
      )}
    </div>
  );
}
