import { Loader2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api, type Settings, type UsageSummary } from '../api';
import { Meter, Panel, Status, toast } from '../components/ui';

// AI & spending: the AI key, the daily budget and answer reuse. Secrets are write-only; a save bar appears on change.

const EMPTY = { sfClientId: '', sfClientSecret: '', sfLoginUrl: '', anthropicKey: '', dailyBudgetUsd: '', anthropicWorkspaceId: '', aiCacheHours: '', maskPii: '', maskFields: '', maxAiCalls: '', maxToolCalls: '', maxTokens: '', retentionDays: '', aiProvider: '', providerKey: '', aiBaseUrl: '', aiModel: '', aiFastModel: '', aiPriceIn: '', aiPriceOut: '', auditInSalesforce: '', alertEmails: '', autoPauseAfter: '', twilioSid: '', twilioToken: '', twilioSms: '', twilioWhatsapp: '' };

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
      maskPii: x.maskPii ?? '', maskFields: x.maskFields ?? '', maxAiCalls: x.maxAiCalls ?? '', maxToolCalls: x.maxToolCalls ?? '', maxTokens: x.maxTokens ?? '', retentionDays: x.retentionDays ?? '',
      aiProvider: x.aiProvider ?? '', providerKey: '', aiBaseUrl: x.aiBaseUrl ?? '', aiModel: x.aiModel ?? '', aiFastModel: x.aiFastModel ?? '', aiPriceIn: x.aiPriceIn ?? '', aiPriceOut: x.aiPriceOut ?? '', auditInSalesforce: x.auditInSalesforce ?? '', alertEmails: x.alertEmails ?? '', autoPauseAfter: x.autoPauseAfter ?? '', twilioSid: x.twilioSid ?? '', twilioToken: '', twilioSms: x.twilioSms ?? '', twilioWhatsapp: x.twilioWhatsapp ?? '' };
    setForm(f); setBase(f);
  });
  useEffect(() => { load().catch((e) => setMsg(e.message)); api.usage().then(setUsage).catch(() => {}); }, []);
  const dirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(base), [form, base]);

  const save = async () => {
    setSaving(true); setMsg('');
    try {
      // Secrets are only sent when typed, so a blank field never wipes a stored value.
      const body: Record<string, string> = { sfClientId: form.sfClientId, sfLoginUrl: form.sfLoginUrl, dailyBudgetUsd: form.dailyBudgetUsd.trim(), anthropicWorkspaceId: form.anthropicWorkspaceId.trim(), aiCacheHours: form.aiCacheHours.trim(),
        maskPii: form.maskPii, maskFields: form.maskFields.trim(), maxAiCalls: form.maxAiCalls.trim(), maxToolCalls: form.maxToolCalls.trim(), maxTokens: form.maxTokens.trim(), retentionDays: form.retentionDays.trim(),
        aiProvider: form.aiProvider, aiBaseUrl: form.aiBaseUrl.trim(), aiModel: form.aiModel.trim(), aiFastModel: form.aiFastModel.trim(), aiPriceIn: form.aiPriceIn.trim(), aiPriceOut: form.aiPriceOut.trim(), auditInSalesforce: form.auditInSalesforce, alertEmails: form.alertEmails, autoPauseAfter: form.autoPauseAfter.trim(),
        twilioSid: form.twilioSid.trim(), twilioSms: form.twilioSms.replace(/[\s()-]/g, ''), twilioWhatsapp: form.twilioWhatsapp.replace(/[\s()-]/g, '') };
      if (form.twilioToken) body.twilioToken = form.twilioToken.trim();
      if (form.providerKey) body.providerKey = form.providerKey;
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
      <Panel title="AI provider">
        <div className="form">
          <div className="frow">
            <div className="flabel"><b>Provider</b><span>Claude is recommended and tested most. Others use your own account and key.</span></div>
            <div className="ffield">
              <select value={form.aiProvider || 'anthropic'} onChange={(e) => { setMsg(''); setForm({ ...form, aiProvider: e.target.value === 'anthropic' ? '' : e.target.value }); }} aria-label="AI provider">
                <option value="anthropic">Claude (Anthropic)</option>
                <option value="openai">OpenAI</option>
                <option value="gemini">Google Gemini</option>
                <option value="compatible">Other (OpenAI-compatible: Azure, Mistral, DeepSeek, self-hosted…)</option>
              </select>
            </div>
          </div>
          {form.aiProvider && form.aiProvider !== 'anthropic' && <>
            <div className="frow">
              <div className="flabel"><b>API key</b><span>Stored encrypted.</span></div>
              <div className="ffield"><div className="row" style={{ gap: 8 }}>
                <input type="password" value={form.providerKey} onChange={set('providerKey')} placeholder={s?.providerKey?.set ? '•••••••• saved, type to replace' : 'Key from the provider'} />
                {s?.providerKey?.set ? <Status tone="ok">Saved</Status> : <Status tone="warn">Missing</Status>}
              </div></div>
            </div>
            {form.aiProvider === 'compatible' && (
              <div className="frow"><div className="flabel"><b>Base URL</b><span>Ends before /chat/completions.</span></div>
                <div className="ffield"><input value={form.aiBaseUrl} onChange={set('aiBaseUrl')} placeholder="https://api.example.com/v1" /></div></div>
            )}
            <div className="frow"><div className="flabel"><b>Model</b><span>Used for writing and research. The low-cost model is used for sorting into categories.</span></div>
              <div className="ffield row" style={{ gap: 8 }}><input value={form.aiModel} onChange={set('aiModel')} placeholder="Main model name" /><input value={form.aiFastModel} onChange={set('aiFastModel')} placeholder="Low-cost model (optional)" /></div></div>
            <div className="frow"><div className="flabel"><b>Prices</b><span>USD per million tokens, so spending and the daily budget stay right.</span></div>
              <div className="ffield row" style={{ gap: 8 }}><input value={form.aiPriceIn} onChange={set('aiPriceIn')} placeholder="Input, e.g. 5" /><input value={form.aiPriceOut} onChange={set('aiPriceOut')} placeholder="Output, e.g. 15" /></div></div>
            <p className="muted small" style={{ margin: 0 }}>Reading scanned PDFs still uses Claude, so keep a Claude key below if you upload scans.</p>
          </>}
        </div>
      </Panel>

      <Panel title="Claude key">
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

      <Panel title="Record of changes in Salesforce">
        <div className="setting-row">
          <div><b>{form.auditInSalesforce === 'off' ? 'Off' : 'On (recommended)'}</b>
            <p className="muted small">Every change an agent makes is also recorded in Salesforce (CRMagents Agent Activity): which agent, what changed, for whom and who approved. Shown on the record's Suggestions card. One API call per run that changed something.</p></div>
          <label className="check"><input type="checkbox" checked={form.auditInSalesforce !== 'off'} onChange={(e) => { setMsg(''); setForm({ ...form, auditInSalesforce: e.target.checked ? 'on' : 'off' }); }} /> Record changes</label>
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

      <Panel title="Alerts">
        <div className="form">
          <div className="frow">
            <div className="flabel"><b>Email admins</b><span>Owners and admins get an email when an agent keeps failing, is paused, or an org is disconnected. Alerts always show under the bell too.</span></div>
            <div className="ffield">
              <label className="check"><input id="alert-emails" type="checkbox" checked={form.alertEmails !== 'off'} onChange={(e) => { setMsg(''); setForm({ ...form, alertEmails: e.target.checked ? 'on' : 'off' }); }} /> {form.alertEmails === 'off' ? 'Off: only in the app' : 'On (recommended)'}</label>
            </div>
          </div>
          <div className="frow">
            <div className="flabel"><b>Pause an agent after</b><span>Failed runs in a row before CRMagents turns the agent off, so a broken agent stops using API calls and AI budget. 0 never pauses.</span></div>
            <div className="ffield"><div className="input-affix"><input id="auto-pause" value={form.autoPauseAfter} onChange={set('autoPauseAfter')} placeholder="5" inputMode="numeric" /><span>failures</span></div></div>
          </div>
        </div>
      </Panel>

      <Panel title="Text messages (Twilio)">
        <div className="form">
          <p className="muted small" style={{ margin: 0 }}>For SMS and WhatsApp: assistants answer customers who text you, and agents can send texts. Uses your own Twilio account; Twilio bills you per message.</p>
          <div className="frow"><div className="flabel"><b>Account SID</b><span>Twilio Console → Account info.</span></div>
            <div className="ffield"><input id="tw-sid" value={form.twilioSid} onChange={set('twilioSid')} placeholder="AC…" autoComplete="off" /></div></div>
          <div className="frow"><div className="flabel"><b>Auth token</b><span>Also checks that incoming messages really come from Twilio.</span></div>
            <div className="ffield"><input id="tw-token" type="password" value={form.twilioToken} onChange={set('twilioToken')} placeholder={s?.twilioToken?.set ? '•••••••• saved, type to replace' : ''} autoComplete="off" /></div></div>
          <div className="frow"><div className="flabel"><b>SMS number</b></div>
            <div className="ffield"><input id="tw-sms" value={form.twilioSms} onChange={set('twilioSms')} placeholder="+14155550100" /></div></div>
          <div className="frow"><div className="flabel"><b>WhatsApp sender</b><span>Optional. Your approved WhatsApp number in Twilio.</span></div>
            <div className="ffield"><input id="tw-wa" value={form.twilioWhatsapp} onChange={set('twilioWhatsapp')} placeholder="+14155238886" /></div></div>
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
