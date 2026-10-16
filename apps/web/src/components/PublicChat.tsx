import { Copy, Globe, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type PublicChat } from '../api';
import { toast } from './ui';
import { SelfServiceSettings } from './SelfServiceSettings';

// Website chat for an assistant: answers visitors on the company's own site or Experience Cloud portal using only
// the company's guides, can open a case, and can tell visitors the status of their own case.

export function PublicChatSettings({ tenantId, agentId }: { tenantId: string; agentId: string }) {
  const [c, setC] = useState<PublicChat | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { setC(null); api.publicChat(tenantId, agentId).then(setC).catch(() => {}); }, [tenantId, agentId]);
  if (!c) return null;
  const save = async (next: Partial<PublicChat>) => {
    const b = { ...c, ...next };
    setBusy(true);
    try {
      setC(await api.setPublicChat(tenantId, agentId, { enabled: b.enabled, origins: b.origins, cases: b.cases, greeting: b.greeting, selfService: b.selfService }));
      if ('enabled' in next) toast(b.enabled ? 'Website chat on' : 'Website chat off');
      if ('selfService' in next) toast('Self-service saved');
    }
    catch (e) { toast((e as Error).message, 'bad'); }
    finally { setBusy(false); }
  };
  return (
    <div className="try">
      <div className="row between">
        <h3 className="row" style={{ gap: 6 }}><Globe size={16} /> Website chat</h3>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={c.enabled} onChange={(e) => void save({ enabled: e.target.checked })} disabled={busy} /> {c.enabled ? 'On' : 'Off'}
        </label>
      </div>
      <p className="muted small" style={{ margin: '4px 0 12px' }}>
        Lets this assistant answer visitors on your website or Experience Cloud site. Visitors only get answers from your Knowledge guides,
        {c.cases ? ' can open a case, and can check their own case with its number and email.' : ' and nothing else.'} No other Salesforce data is reachable.
      </p>
      <div className="form">
        <div className="frow"><div className="flabel"><b>Websites</b><span>Only these may show the chat. Empty = any site.</span></div>
          <div className="ffield"><input defaultValue={c.origins} placeholder="https://www.acme.com, *.acme.com" onBlur={(e) => e.target.value !== c.origins && void save({ origins: e.target.value })} /></div></div>
        <div className="frow"><div className="flabel"><b>Greeting</b></div>
          <div className="ffield"><input defaultValue={c.greeting} placeholder="Hi! Ask me about our products, or I can open a case for you." onBlur={(e) => e.target.value !== c.greeting && void save({ greeting: e.target.value })} /></div></div>
        <div className="frow"><div className="flabel"><b>Cases</b></div>
          <div className="ffield"><label className="row small" style={{ gap: 6 }}><input type="checkbox" checked={c.cases} onChange={(e) => void save({ cases: e.target.checked })} /> Can open cases and look up a case's status</label></div></div>
      </div>
      <div className="ss-wrap">
        <SelfServiceSettings key={JSON.stringify(c.selfService)} value={c.selfService} onSave={(selfService) => save({ selfService })} />
      </div>
      {c.snippet && (
        <>
          <p className="small" style={{ margin: '12px 0 6px' }}><b>Add to your site</b> <span className="muted">(paste before &lt;/body&gt;; on Experience Cloud: Settings → Advanced → Head Markup, and add this server under CSP Trusted Sites)</span></p>
          <div className="row" style={{ gap: 6 }}>
            <pre className="code-sample" style={{ margin: 0, flex: 1 }}>{c.snippet}</pre>
            <button onClick={() => { void navigator.clipboard.writeText(c.snippet).then(() => toast('Snippet copied')); }} aria-label="Copy snippet">{busy ? <Loader2 size={14} className="spin" /> : <Copy size={14} />}</button>
          </div>
        </>
      )}
    </div>
  );
}
