import { Link2, Loader2, ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Me, type Tenant } from '../api';
import { Panel, Status, toast } from './ui';

// Acting as each person in Salesforce: an admin turns it on for the workspace; each person links their own
// Salesforce login once. Assistants, dashboards and questions in the app then see and change only what that person
// can in Salesforce (their sharing, field security and object permissions). Background agents keep using the org's
// connection, like any integration user.

const link = async (tenantId: string) => {
  try { location.href = (await api.linkMySalesforce(tenantId)).url; } catch (e) { toast((e as Error).message, 'bad'); }
};

/** Opens when the server says this person must link their Salesforce login first. */
export function LinkPrompt({ tenants }: { tenants: Tenant[] }) {
  const [d, setD] = useState<{ message: string; tenantId?: string } | null>(null);
  useEffect(() => {
    const on = (e: Event) => setD((e as CustomEvent).detail ?? { message: '' });
    window.addEventListener('crmagents:sf-link', on);
    return () => window.removeEventListener('crmagents:sf-link', on);
  }, []);
  if (!d) return null;
  const t = tenants.find((x) => x.id === d.tenantId) ?? tenants[0];
  return (
    <div className="modal" onClick={() => setD(null)}>
      <div className="confirm-card upgrade-card" role="alertdialog" aria-labelledby="link-title" onClick={(e) => e.stopPropagation()}>
        <span className="locked-ico"><ShieldCheck size={16} /></span>
        <h2 id="link-title">Link your Salesforce login</h2>
        <div className="confirm-body">
          {d.message || 'Assistants act as you in Salesforce.'} You log in on Salesforce's own page{t ? <> for <b>{t.sf_instance_url.replace(/^https:\/\//, '')}</b></> : null}; CRMagents never sees your password. You only do this once.
        </div>
        <div className="confirm-actions">
          <button onClick={() => setD(null)}>Not now</button>
          {t && <button className="primary" onClick={() => void link(t.id)}><Link2 size={14} /> Link my Salesforce login</button>}
        </div>
      </div>
    </div>
  );
}

/** Team page: the workspace setting (admins) and this person's own link. */
export function SalesforceAccess({ me, tenant }: { me: Me; tenant?: Tenant }) {
  const admin = me.role === 'owner' || me.role === 'admin';
  const [on, setOn] = useState<boolean>();
  const [mine, setMine] = useState<Awaited<ReturnType<typeof api.mySalesforce>>>();
  const [people, setPeople] = useState<Awaited<ReturnType<typeof api.personLinks>>>();
  const [busy, setBusy] = useState(false);
  const load = () => {
    api.settings().then((s) => setOn(s.actAsPerson === 'on')).catch(() => {});
    if (!tenant) return;
    api.mySalesforce(tenant.id).then(setMine).catch(() => {});
    if (admin) api.personLinks(tenant.id).then(setPeople).catch(() => {});
  };
  useEffect(load, [tenant?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!tenant || on === undefined) return null;
  const toggle = async () => {
    setBusy(true);
    try { await api.saveSettings({ actAsPerson: on ? 'off' : 'on' }); toast(on ? 'Assistants use the org connection again' : 'Assistants now act as each person in Salesforce'); load(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const unlink = async () => {
    setBusy(true);
    try { await api.unlinkMySalesforce(tenant.id); toast('Salesforce login unlinked'); load(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy(false);
  };
  const linkedN = people?.filter((p) => p.sfUsername).length ?? 0;
  return (
    <Panel title="Salesforce access" action={on ? <Status tone="ok">Each person's own access</Status> : <Status tone="neutral">Org connection</Status>}>
      <div className="sfa">
        <div className="sfa-row">
          <div>
            <b>Assistants act as each person in Salesforce</b>
            <p>{on
              ? "Assistants, dashboards and questions in this app see and change only what each person can in Salesforce: their sharing rules, field security and object permissions, and changes show their name in the field history. Each person links their own Salesforce login once. Agents running in the background still use the org's connection, like any integration."
              : "Off: assistants in this app use the org's connection, which usually sees everything. Inside Salesforce, assistants always act as the person asking. Turn this on when people with different access use the app."}</p>
          </div>
          {admin ? <button className={on ? 'sm' : 'sm primary'} disabled={busy} onClick={() => void toggle()}>{on ? 'Turn off' : 'Turn on'}</button> : <span className="muted small">{on ? 'On' : 'Off'} · set by admins</span>}
        </div>
        {mine && <div className="sfa-row">
          <div>
            <b>Your Salesforce login</b>
            <p>{mine.linked ? <>Linked as <b>{mine.sfUsername}</b>. Assistants act as this user when the setting is on.</> : on ? 'Not linked yet: assistants will ask you to link it before they answer.' : "Not linked. You'll only need it if an admin turns on acting as each person."}</p>
          </div>
          {mine.linked ? <button className="sm" disabled={busy} onClick={() => void unlink()}>Unlink</button> : <button className={on ? 'sm primary' : 'sm'} disabled={busy} onClick={() => void link(tenant.id)}>{busy ? <Loader2 size={14} className="spin" /> : <Link2 size={14} />} Link my login</button>}
        </div>}
        {admin && on && people && <div className="sfa-people">
          <span className="muted small">{linkedN} of {people.length} people linked</span>
          <ul>{people.map((p) => <li key={p.email}><span>{p.email}</span>{p.sfUsername ? <Status tone="ok">{p.sfUsername}</Status> : <Status tone="neutral">Not linked</Status>}</li>)}</ul>
        </div>}
      </div>
    </Panel>
  );
}
