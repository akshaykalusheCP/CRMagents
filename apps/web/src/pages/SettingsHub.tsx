import { useState } from 'react';
import { RulesPage } from './Rules';
import type { Me, Tenant } from '../api';
import { TeamPage } from './Team';
import { PlanPage } from './PlanPage';
import { PageHeader } from '../components/ui';
import { ConnectionsPage } from './Connections';
import { SettingsPage } from './Settings';

// Settings with a section menu on the left; each section keeps its own page.
const SECTIONS = [
  { id: 'orgs', label: 'Salesforce orgs', desc: 'Connect orgs and check their status.' },
  { id: 'ai', label: 'AI & spending', desc: 'Your AI key, daily budget and answer reuse.' },
  { id: 'plan', label: 'Plan', desc: 'What your workspace includes, what it uses, and upgrades.' },
  { id: 'team', label: 'Team', desc: 'Who can sign in, and what each person may do. Invite people by email.' },
  { id: 'rules', label: 'Rules', desc: 'Limits for every agent: things they must never do, or must ask a person about first. Checked by code before every change.' },
] as const;

export type SettingsSection = 'orgs' | 'ai' | 'plan' | 'team' | 'rules';

export function SettingsHub({ tenants, onChange, tenant, section, focusConnect, me, openAdmin }: { tenants: Tenant[]; onChange: () => void; tenant?: Tenant; section?: SettingsSection; focusConnect?: boolean; me: Me; openAdmin?: () => void }) {
  const [tab, setTab] = useState<SettingsSection>(section ?? 'orgs');
  const cur = SECTIONS.find((s) => s.id === tab)!;
  return (
    <div className="pg">
      <PageHeader title="Settings" description="Workspace settings apply to everyone in your company." />
      <div className="settings2">
        <nav className="snav" aria-label="Settings sections">
          {SECTIONS.map((s) => <button key={s.id} className={tab === s.id ? 'on' : ''} onClick={() => setTab(s.id)} aria-current={tab === s.id ? 'page' : undefined}>{s.label}</button>)}
        </nav>
        <div>
          <div className="ph-text" style={{ marginBottom: 16 }}><h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{cur.label}</h2><p className="ph-desc">{cur.desc}</p></div>
          {tab === 'orgs' ? <ConnectionsPage tenants={tenants} onChange={onChange} goSettings={() => setTab('ai')} focusConnect={focusConnect} /> : tab === 'ai' ? <SettingsPage /> : tab === 'team' ? <TeamPage me={me} /> : tab === 'plan' ? <PlanPage me={me} openAdmin={openAdmin} /> : <RulesPage tenant={tenant} />}
        </div>
      </div>
    </div>
  );
}
