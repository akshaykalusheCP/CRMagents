import { Copy, KeyRound, Loader2, Mail, Trash2, UserPlus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ROLES } from '@crmagents/shared';
import { api, type Me, type Team, type Tenant } from '../api';
import { SalesforceAccess } from '../components/PersonLink';
import { Empty, Panel, SkeletonRows, Status, Table, toast, useConfirm } from '../components/ui';

// Team: who can sign in to this workspace and what each person may do. Admins invite people by email with a
// role; the invite link can also be copied and sent another way (it works once, for 7 days).

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', builder: 'Builder', approver: 'Approver' };
const when = (d: string | null) => {
  if (!d) return 'Never';
  const m = (Date.now() - new Date(d).getTime()) / 60_000;
  if (m < 2) return 'Just now';
  if (m < 60) return `${Math.round(m)} min ago`;
  if (m < 1440) return `${Math.round(m / 60)} h ago`;
  return new Date(d).toLocaleDateString();
};

function copy(text: string, what: string) {
  void navigator.clipboard?.writeText(text).then(() => toast(`${what} copied`), () => toast(text, 'info'));
}

export function TeamPage({ me, tenant }: { me: Me; tenant?: Tenant }) {
  const [team, setTeam] = useState<Team>();
  const [err, setErr] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('builder');
  const [busy, setBusy] = useState(false);
  const [lastLink, setLastLink] = useState<{ email: string; link: string; emailed: boolean } | null>(null);
  const [confirmUi, ask] = useConfirm();

  const load = () => api.team().then(setTeam).catch((e) => setErr((e as Error).message));
  useEffect(() => { void load(); }, []);

  const invite = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.inviteUser(email.trim(), role);
      setLastLink({ email: email.trim(), link: r.link, emailed: r.emailed });
      toast(r.emailed ? `Invitation sent to ${email.trim()}` : 'Invitation created: copy the link and send it');
      setEmail('');
      await load();
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };

  const act = async (fn: () => Promise<unknown>, done: string) => {
    try { await fn(); toast(done); await load(); } catch (e) { toast((e as Error).message, 'bad'); }
  };

  const manage = !!team?.canManage;
  const owner = me.role === 'owner';

  return (
    <div className="smart-col">
      {confirmUi}
      {manage && (
        <Panel title="Invite someone">
          <form className="team-invite" onSubmit={invite}>
            <input type="email" placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required aria-label="Email" />
            <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Role">
              {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
            </select>
            <button className="primary" disabled={busy}>{busy ? <Loader2 size={15} className="spin" /> : <UserPlus size={15} />} Invite</button>
          </form>
          <p className="muted small team-role-help">{ROLES.find((r) => r.id === role)?.help}</p>
          {err && <div className="err">{err}</div>}
          {lastLink && (
            <div className="team-link">
              <span>{lastLink.emailed ? <>Emailed to <b>{lastLink.email}</b>. You can also share the link:</> : <>Email isn't set up for this workspace, so send <b>{lastLink.email}</b> this link yourself:</>}</span>
              <div className="team-link-row"><code>{lastLink.link}</code><button className="ghost sm" onClick={() => copy(lastLink.link, 'Link')}><Copy size={14} /> Copy</button></div>
            </div>
          )}
        </Panel>
      )}

      <Panel title="People" flush>
        {!team ? <SkeletonRows rows={3} cols={4} /> : (
          <Table
            rows={team.users}
            rowKey={(u) => u.id}
            columns={[
              { key: 'email', header: 'Person', render: (u) => <span className="team-who"><span className="ws-mark sm">{u.email.slice(0, 2).toUpperCase()}</span>{u.email}{u.id === team.me && <span className="muted small"> (you)</span>}</span> },
              { key: 'role', header: 'Role', width: '150px', render: (u) => manage && u.id !== team.me && (owner || u.role !== 'owner') ? (
                <select className="sm" value={u.role} aria-label={`Role for ${u.email}`} onChange={(e) => void act(() => api.setUserRole(u.id, e.target.value), 'Role changed')}>
                  {owner && <option value="owner">Owner</option>}
                  {ROLES.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                </select>
              ) : <span>{ROLE_LABEL[u.role] ?? u.role}</span> },
              { key: 'seen', header: 'Last sign-in', width: '130px', hideSm: true, render: (u) => <span className="muted">{when(u.lastLoginAt)}</span> },
              { key: 'x', header: '', width: '90px', align: 'right', render: (u) => manage && u.id !== team.me && (owner || u.role !== 'owner') ? (
                <span className="row-actions">
                  <button className="ghost icon" title="Password reset link" aria-label={`Password reset link for ${u.email}`} onClick={() => void (async () => {
                    try { const r = await api.resetLink(u.id); copy(r.link, r.emailed ? 'Reset link emailed and' : 'Reset link'); } catch (e) { toast((e as Error).message, 'bad'); }
                  })()}><KeyRound size={15} /></button>
                  <button className="ghost icon" title="Remove" aria-label={`Remove ${u.email}`} onClick={() => void (async () => {
                    if (await ask({ title: `Remove ${u.email}?`, body: 'They are signed out at once and can no longer open this workspace. Agents and runs they made stay.', confirm: 'Remove', danger: true })) await act(() => api.removeUser(u.id), 'Removed');
                  })()}><Trash2 size={15} /></button>
                </span>
              ) : null },
            ]}
          />
        )}
      </Panel>

      {manage && !!team?.invites.length && (
        <Panel title="Waiting to join" flush>
          <Table
            rows={team.invites}
            rowKey={(i) => i.id}
            columns={[
              { key: 'email', header: 'Invited', render: (i) => <span className="team-who"><Mail size={15} className="muted" />{i.email}</span> },
              { key: 'role', header: 'Role', width: '150px', render: (i) => ROLE_LABEL[i.role] ?? i.role },
              { key: 'exp', header: 'Expires', width: '130px', hideSm: true, render: (i) => <Status tone="warn">{new Date(i.expiresAt).toLocaleDateString()}</Status> },
              { key: 'x', header: '', width: '90px', align: 'right', render: (i) => (
                <button className="ghost sm" onClick={() => void act(() => api.cancelInvite(i.id), 'Invitation cancelled')}>Cancel</button>
              ) },
            ]}
          />
        </Panel>
      )}

      {team && !manage && <Empty title={`You're ${ROLE_LABEL[me.role] === 'Admin' ? 'an' : 'a'} ${ROLE_LABEL[me.role] ?? me.role}`} body="Only owners and admins can invite people or change roles." />}

      <SalesforceAccess me={me} tenant={tenant} />

      <ChangePassword />
    </div>
  );
}

function ChangePassword() {
  const [f, setF] = useState({ current: '', next: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try { await api.changePassword(f.current, f.next); setF({ current: '', next: '' }); toast('Password changed. Other devices were signed out.'); }
    catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <Panel title="Your password">
      <form className="form" onSubmit={save}>
        <div className="frow">
          <div className="flabel"><b>Current password</b></div>
          <div className="ffield"><input type="password" autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required /></div>
        </div>
        <div className="frow">
          <div className="flabel"><b>New password</b><span>At least 10 characters. Other devices are signed out.</span></div>
          <div className="ffield"><input type="password" autoComplete="new-password" minLength={10} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required /></div>
        </div>
        {err && <div className="err">{err}</div>}
        <div><button className="primary" disabled={busy || !f.current || f.next.length < 10}>{busy && <Loader2 size={15} className="spin" />} Change password</button></div>
      </form>
    </Panel>
  );
}
