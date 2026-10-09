import { useState } from 'react';
import type { Tenant } from '../api';
import { ConnectionsPage } from './Connections';
import { SettingsPage } from './Settings';

// Settings split into two plain tabs; Salesforce connections live here instead of the main menu.
export function SettingsHub({ tenants, onChange }: { tenants: Tenant[]; onChange: () => void }) {
  const [tab, setTab] = useState<'orgs' | 'ai'>(() => (tenants.length && tenants.every((t) => t.setup_status === 'ready') ? 'ai' : 'orgs'));
  return (
    <div>
      <div className="tabs page-tabs">
        <button className={tab === 'orgs' ? 'on' : ''} onClick={() => setTab('orgs')}>Salesforce orgs</button>
        <button className={tab === 'ai' ? 'on' : ''} onClick={() => setTab('ai')}>AI &amp; spending</button>
      </div>
      {tab === 'orgs' ? <ConnectionsPage tenants={tenants} onChange={onChange} goSettings={() => setTab('ai')} /> : <SettingsPage />}
    </div>
  );
}
