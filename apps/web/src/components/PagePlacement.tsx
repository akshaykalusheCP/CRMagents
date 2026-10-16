import { ExternalLink, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type SfPage, type Tenant } from '../api';
import { toast } from './ui';

// One-click placement of the Agent Panel (utility bar) and the Suggestions card + panel (record pages).

const OBJECTS = ['Case', 'Account', 'Contact', 'Lead', 'Opportunity'];

export function UtilityBarPicker({ tenant }: { tenant: Tenant }) {
  const [bars, setBars] = useState<SfPage[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.sfPages(tenant.id).then((r) => { const ok = r.utilityBars.filter((b) => !b.managed); setBars(ok); setPick(ok[0]?.id ?? ''); }).catch(() => setBars([])); }, [tenant.id]);
  if (!bars) return <Loader2 size={14} className="spin" />;
  if (!bars.length) return <span className="muted small">No app has a utility bar yet: add one in App Manager first.</span>;
  return (
    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
      <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="App utility bar">{bars.map((b) => <option key={b.id} value={b.id}>{b.label.replace(/ Utility Bar$/i, '')}</option>)}</select>
      <button className="sm primary" disabled={busy || !pick} onClick={async () => {
        setBusy(true);
        try { const r = await api.addToUtilityBar(tenant.id, pick); toast(r.changed ? `Added to ${r.label}. Reload Salesforce to see it.` : `Already in ${r.label}`); }
        catch (e) { toast((e as Error).message, 'bad'); }
        finally { setBusy(false); }
      }}>{busy ? <Loader2 size={14} className="spin" /> : null} Add to utility bar</button>
    </div>
  );
}

export function RecordPagePicker({ tenant }: { tenant: Tenant }) {
  const [object, setObject] = useState('Case');
  const [pages, setPages] = useState<SfPage[] | null>(null);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const [activate, setActivate] = useState<string | null>(null);
  useEffect(() => {
    setPages(null); setActivate(null);
    api.sfPages(tenant.id, object).then((r) => { const ok = r.recordPages.filter((p) => !p.managed); setPages(ok); setPick(ok[0]?.id ?? ''); }).catch(() => setPages([]));
  }, [tenant.id, object]);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <select value={object} onChange={(e) => setObject(e.target.value)} aria-label="Object">{OBJECTS.map((o) => <option key={o}>{o}</option>)}</select>
        {pages === null ? <Loader2 size={14} className="spin" /> : (
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Record page">
            {pages.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            <option value="">A new page with everything</option>
          </select>
        )}
        <button className="sm primary" disabled={busy || pages === null} onClick={async () => {
          setBusy(true); setActivate(null);
          try {
            const r = await api.addToRecordPage(tenant.id, object, pick || undefined);
            if (r.activateUrl) { setActivate(r.activateUrl); toast(`Created "${r.label}". Activate it to show it to people.`); }
            else toast(r.changed ? `Added to ${r.label}. Reload a ${object} in Salesforce.` : `Already on ${r.label}`);
          } catch (e) { toast((e as Error).message, 'bad'); }
          finally { setBusy(false); }
        }}>{busy ? <Loader2 size={14} className="spin" /> : null} Add cards</button>
      </div>
      {activate && <a className="link-btn" href={activate} target="_blank" rel="noreferrer">Activate it in App Builder (Activation → Assign as Org Default) <ExternalLink size={13} /></a>}
    </div>
  );
}
