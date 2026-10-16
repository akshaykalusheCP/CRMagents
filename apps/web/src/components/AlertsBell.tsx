import { AlertTriangle, Bell, PauseCircle, Unplug } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api, type Alert } from '../api';
import { Menu } from './ui';

// The bell: alerts about agents that keep failing or were paused, and orgs that were disconnected.
// Checked every minute; opening the list marks them read.

const ICON: Record<string, React.ReactNode> = {
  failing: <AlertTriangle size={15} className="al-warn" />,
  paused: <PauseCircle size={15} className="al-bad" />,
  disconnected: <Unplug size={15} className="al-bad" />,
};
const ago = (d: string) => {
  const m = (Date.now() - new Date(d).getTime()) / 60_000;
  return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(d).toLocaleDateString();
};

export function AlertsBell({ onOpen }: { onOpen: (a: Alert) => void }) {
  const [data, setData] = useState<{ alerts: Alert[]; unread: number }>({ alerts: [], unread: 0 });
  useEffect(() => {
    const load = () => { if (document.visibilityState === 'visible') api.alerts().then(setData).catch(() => {}); };
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, []);
  const opened = () => {
    if (!data.unread) return;
    void api.readAlerts().catch(() => {});
    // Keep the unread look until the menu closes; the count goes now.
    setData((d) => ({ ...d, unread: 0 }));
  };
  return (
    <Menu align="right" className="alerts-menu" trigger={(open) => (
      <button className={'ghost icon bell' + (open ? ' on' : '')} aria-label={data.unread ? `Alerts, ${data.unread} new` : 'Alerts'} title="Alerts" onClick={opened}>
        <Bell size={16} />{data.unread > 0 && <span className="bell-dot">{data.unread > 9 ? '9+' : data.unread}</span>}
      </button>
    )}>
      {(close) => (
        <>
          <div className="mh">Alerts</div>
          {!data.alerts.length && <div className="al-empty">Nothing needs attention. You'll hear here, and by email, if an agent keeps failing or an org disconnects.</div>}
          <div className="al-list">
            {data.alerts.map((a) => (
              <button key={a.id} className={'al-item' + (a.readAt ? '' : ' new')} onClick={() => { close(); onOpen(a); }}>
                {ICON[a.kind] ?? <Bell size={15} />}
                <span className="al-text"><b>{a.title}</b><span>{a.body.split('\n')[0]}</span><small>{ago(a.createdAt)}</small></span>
              </button>
            ))}
          </div>
        </>
      )}
    </Menu>
  );
}
