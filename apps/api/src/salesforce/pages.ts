import type { SalesforceClient } from './client.js';

// Puts Nimbus on Salesforce pages without App Builder: the Agent Panel into an app's utility bar, and the
// Suggestions card + Agent Panel onto a record page (an existing Lightning page, or a new one the admin activates).
// Uses the Tooling API's FlexiPage metadata; pages from managed packages can't be changed and say so.

const PANEL = 'crmAgentsPanel';
const SUGGESTIONS = 'crmSuggestions';

interface ItemInstance { componentInstance?: { componentName: string; identifier: string; componentInstanceProperties?: { name: string; value: string; type?: string }[] } | null; fieldInstance?: unknown }
interface Region { name: string; type: string; itemInstances?: ItemInstance[]; mode?: string | null; [k: string]: unknown }
interface FlexiMeta { flexiPageRegions: Region[]; masterLabel: string; template?: { name: string }; type: string; sobjectType?: string | null; [k: string]: unknown }

// Salesforce reports our components as "c:crmAgentsPanel" when reading a page back.
const has = (m: FlexiMeta, name: string) => m.flexiPageRegions.some((r) => (r.itemInstances ?? []).some((i) => i.componentInstance?.componentName.replace(/^c:/, '') === name));

/** `utility` = properties of the utility item itself (size, icon, label): Salesforce calls these decorators. */
const component = (name: string, id: string, utility: Record<string, string> = {}): ItemInstance => ({
  componentInstance: { componentName: name, identifier: id, componentInstanceProperties: Object.entries(utility).map(([n, value]) => ({ name: n, value, type: 'decorator' })) },
});

/** Adds the panel as a utility item (once). Pure; tested. */
export function withUtilityPanel(m: FlexiMeta): FlexiMeta {
  if (has(m, PANEL)) return m;
  const regions = m.flexiPageRegions.length ? m.flexiPageRegions : [{ name: 'utilityItems', type: 'Region', itemInstances: [] }];
  const target = regions.find((r) => r.name === 'utilityItems') ?? regions[0];
  target.itemInstances = [...(target.itemInstances ?? []), component(PANEL, 'crmAgentsPanel_utility', {
    eager: 'false', height: '560', width: '380', icon: 'einstein', label: 'Nimbus', scrollable: 'true',
  })];
  return { ...m, flexiPageRegions: regions };
}

/** Adds the Suggestions card and the Agent Panel to a record page's side column (or its last column). Pure; tested. */
export function withRecordCards(m: FlexiMeta): FlexiMeta {
  const regions = m.flexiPageRegions.filter((r) => r.type === 'Region');
  const target = regions.find((r) => /sidebar|right/i.test(r.name)) ?? regions[regions.length - 1];
  if (!target) throw new Error('This page has no column to add cards to.');
  const add: ItemInstance[] = [];
  const tag = Date.now().toString(36);
  if (!has(m, SUGGESTIONS)) add.push(component(SUGGESTIONS, `crmSuggestions_${tag}`));
  if (!has(m, PANEL)) add.push(component(PANEL, `crmAgentsPanel_${tag}`));
  // At the top of the column: where support agents look first.
  target.itemInstances = [...add, ...(target.itemInstances ?? [])];
  return m;
}

/** A new record page: highlights, details and related lists, with the Nimbus cards on the side. Pure; tested. */
export function newRecordPage(object: string): FlexiMeta {
  return {
    masterLabel: `Nimbus ${object} Record Page`,
    type: 'RecordPage',
    sobjectType: object,
    template: { name: 'flexipage:recordHomeTemplateDesktop' },
    flexiPageRegions: [
      { name: 'header', type: 'Region', itemInstances: [component('force:highlightsPanel', 'highlights')] },
      { name: 'main', type: 'Region', itemInstances: [component('force:detailPanel', 'details'), component('force:relatedListContainer', 'related')] },
      { name: 'sidebar', type: 'Region', itemInstances: [component(SUGGESTIONS, 'crmSuggestions_record'), component(PANEL, 'crmAgentsPanel_record')] },
    ],
  };
}

export async function listPages(sf: SalesforceClient, object?: string) {
  const bars = await sf.toolingQuery<{ Id: string; MasterLabel: string; DeveloperName: string; NamespacePrefix: string | null }>(
    "SELECT Id, MasterLabel, DeveloperName, NamespacePrefix FROM FlexiPage WHERE Type = 'UtilityBar' ORDER BY MasterLabel");
  const records = object && /^\w+$/.test(object)
    ? await sf.toolingQuery<{ Id: string; MasterLabel: string; DeveloperName: string; NamespacePrefix: string | null }>(
      `SELECT Id, MasterLabel, DeveloperName, NamespacePrefix FROM FlexiPage WHERE Type = 'RecordPage' AND EntityDefinitionId = '${object}' ORDER BY MasterLabel`)
    : { records: [] };
  return {
    utilityBars: bars.records.map((p) => ({ id: p.Id, label: p.MasterLabel, managed: !!p.NamespacePrefix })),
    recordPages: records.records.map((p) => ({ id: p.Id, label: p.MasterLabel, managed: !!p.NamespacePrefix })),
  };
}

async function readPage(sf: SalesforceClient, id: string): Promise<FlexiMeta> {
  if (!/^0M0[a-zA-Z0-9]{12,15}$/.test(id)) throw new Error('Bad page Id');
  const p = await sf.tooling<{ Metadata: FlexiMeta; NamespacePrefix?: string | null }>('GET', `/sobjects/FlexiPage/${id}`);
  if (p.NamespacePrefix) throw new Error('This page comes from an installed package and can\'t be changed. Pick another page or create a new one.');
  return p.Metadata;
}

const friendly = (e: unknown) => {
  const msg = String(e instanceof Error ? e.message : e).replace(/^Salesforce \w+ \S+ -> \d+: /, '');
  return new Error(`Salesforce didn't accept the page change: ${msg.slice(0, 300)}`);
};

export async function addToUtilityBar(sf: SalesforceClient, id: string) {
  const m = await readPage(sf, id);
  if (has(m, PANEL)) return { changed: false, label: m.masterLabel };
  await sf.tooling('PATCH', `/sobjects/FlexiPage/${id}`, { Metadata: withUtilityPanel(m) }).catch((e) => { throw friendly(e); });
  return { changed: true, label: m.masterLabel };
}

/** Adds the cards to an existing record page, or creates a new page for the object. */
export async function addToRecordPage(sf: SalesforceClient, object: string, instanceUrl: string, id?: string) {
  if (id) {
    const m = await readPage(sf, id);
    if (has(m, PANEL) && has(m, SUGGESTIONS)) return { changed: false, id, label: m.masterLabel, activateUrl: null };
    await sf.tooling('PATCH', `/sobjects/FlexiPage/${id}`, { Metadata: withRecordCards(m) }).catch((e) => { throw friendly(e); });
    return { changed: true, id, label: m.masterLabel, activateUrl: null };
  }
  if (!/^\w+$/.test(object)) throw new Error('Bad object name');
  const fullName = `CRMagents_${object.replace(/__c$/, '')}_Record_Page`.slice(0, 40);
  const existing = await sf.toolingQuery<{ Id: string }>(`SELECT Id FROM FlexiPage WHERE DeveloperName = '${fullName}' LIMIT 1`);
  if (existing.records[0]) return addToRecordPage(sf, object, instanceUrl, existing.records[0].Id);
  const r = await sf.tooling<{ id: string }>('POST', '/sobjects/FlexiPage', { FullName: fullName, Metadata: newRecordPage(object) }).catch((e) => { throw friendly(e); });
  // New pages need an admin to activate them (Salesforce only lets that happen in App Builder).
  return { changed: true, id: r.id, label: `Nimbus ${object} Record Page`, activateUrl: `${instanceUrl}/visualEditor/appBuilder.app?id=${r.id}` };
}
