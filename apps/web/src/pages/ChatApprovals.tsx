import { Loader2, MessageSquare, Send, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Me } from '../api';
import { Panel, Status, toast } from '../components/ui';

// Approvals in Slack and Microsoft Teams: where approval requests go besides the app and Salesforce.
// Slack is interactive (Approve / Reject in the message); Teams gets a card that opens the approval here.

type State = Awaited<ReturnType<typeof api.chatApprovals>>;

export function ChatApprovalsPage({ me }: { me: Me }) {
  const admin = me.role === 'owner' || me.role === 'admin';
  const [s, setS] = useState<State>();
  const [hook, setHook] = useState('');
  const [busy, setBusy] = useState('');
  const load = () => api.chatApprovals().then(setS).catch((e) => toast((e as Error).message, 'bad'));
  useEffect(() => {
    void load();
    const q = new URLSearchParams(location.search);
    if (q.get('slack') === 'connected') { toast('Slack connected: approval requests will post to your channel'); history.replaceState(null, '', '/'); }
  }, []);
  const run = async (key: string, f: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try { await f(); if (ok) toast(ok); await load(); } catch (e) { toast((e as Error).message, 'bad'); }
    setBusy('');
  };
  const test = (kind: 'slack' | 'teams') => run(`test-${kind}`, async () => {
    const r = await api.testChatApprovals(kind);
    if (!r.ok) throw new Error(r.error ?? 'Not sent');
    toast(`Test sent to ${kind === 'slack' ? 'Slack' : 'Teams'}`);
  });
  if (!s) return null;
  const err = new URLSearchParams(location.search).get('error');
  return (
    <div className="smart-col">
      {err && <div className="banner bad"><div><b>Couldn't connect</b><span>{err}</span></div></div>}
      <Panel title="Slack" action={s.slack.connected ? <Status tone="ok">Connected</Status> : !s.slack.available ? <Status tone="neutral">Not available yet</Status> : <Status tone="neutral">Not connected</Status>}>
        <div className="chat-ap">
          <p>Approval requests post to a Slack channel with <b>Approve</b> and <b>Reject</b> buttons. A click counts only when the person's Slack email belongs to someone in this workspace, and the usual rules apply: whoever started a run can't approve it, and assigned approvals go to the right person. The message then shows who decided, wherever they decided.</p>
          {s.slack.connected ? (
            <div className="chat-ap-row">
              <span><MessageSquare size={15} /> Posting to <b>{s.slack.channel ?? 'a channel'}</b>{s.slack.team ? <> in {s.slack.team}</> : null}{s.slack.by ? <span className="muted"> · added by {s.slack.by}</span> : null}</span>
              {admin && <span className="row" style={{ gap: 6 }}>
                <button className="sm" disabled={!!busy} onClick={() => void test('slack')}>{busy === 'test-slack' ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send a test</button>
                <button className="sm" disabled={!!busy} onClick={() => void run('rm-slack', () => api.removeChatApprovals('slack'), 'Slack disconnected')}><Unplug size={14} /> Disconnect</button>
              </span>}
            </div>
          ) : !s.slack.available ? (
            <p className="muted small">Slack isn't switched on for CRMagents yet. Approvals still reach people in the app and in Salesforce.</p>
          ) : admin ? (
            <button className="primary" style={{ alignSelf: 'flex-start' }} disabled={!!busy} onClick={() => void run('add-slack', async () => { location.href = (await api.installSlack()).url; })}>Add to Slack</button>
          ) : <p className="muted small">An admin can add CRMagents to a Slack channel.</p>}
        </div>
      </Panel>

      <Panel title="Microsoft Teams" action={s.teams.connected ? <Status tone="ok">Connected</Status> : <Status tone="neutral">Not connected</Status>}>
        <div className="chat-ap">
          <p>Approval requests post to a Teams channel as a card with a <b>Review and approve</b> button that opens the request here. (Teams' simple webhooks can't take button clicks, so the decision itself happens in CRMagents or Salesforce.)</p>
          {s.teams.connected ? (
            <div className="chat-ap-row">
              <span><MessageSquare size={15} /> Posting to your Teams channel{s.teams.by ? <span className="muted"> · added by {s.teams.by}</span> : null}</span>
              {admin && <span className="row" style={{ gap: 6 }}>
                <button className="sm" disabled={!!busy} onClick={() => void test('teams')}>{busy === 'test-teams' ? <Loader2 size={14} className="spin" /> : <Send size={14} />} Send a test</button>
                <button className="sm" disabled={!!busy} onClick={() => void run('rm-teams', () => api.removeChatApprovals('teams'), 'Teams disconnected')}><Unplug size={14} /> Disconnect</button>
              </span>}
            </div>
          ) : admin ? (
            <>
              <ol className="small steps-ol">
                <li>In Teams, open the channel → <b>Workflows</b> → <b>Post to a channel when a webhook request is received</b>.</li>
                <li>Finish the steps and copy the webhook address it gives you.</li>
              </ol>
              <div className="chat-ap-row">
                <input value={hook} onChange={(e) => setHook(e.target.value)} placeholder="https://…logic.azure.com/workflows/…" aria-label="Teams webhook address" />
                <button className="primary sm" disabled={!hook.trim() || !!busy} onClick={() => void run('add-teams', async () => { await api.setTeamsApprovals(hook.trim()); setHook(''); }, 'Teams connected')}>Connect</button>
              </div>
            </>
          ) : <p className="muted small">An admin can connect a Teams channel.</p>}
        </div>
      </Panel>
    </div>
  );
}
