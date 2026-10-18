// Captures demo data for the web app's demo mode (/?demo) from one connected org. Read-only; the briefing is
// reused from cache when the numbers haven't changed. Usage:
//   DEMO_SF_USERNAME=me@myorg.com npx tsx --env-file=../../.env scripts/capture-demo.mts
import { writeFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { SalesforceClient } from '../src/salesforce/client.js';
import { cachedInsights } from '../src/insights/metrics.js';
import { summarize } from '../src/insights/ai.js';
import { runTiles } from '../src/insights/dashboards.js';

const username = process.env.DEMO_SF_USERNAME;
if (!username) throw new Error('Set DEMO_SF_USERNAME to the Salesforce username of a demo/dev org');
const { rows } = await pool.query('select id from tenants where sf_username = $1 limit 1', [username]);
if (!rows[0]) throw new Error(`No connected org for ${username}`);
const id = rows[0].id;
const sf = await SalesforceClient.forTenant(id);

const insights: Record<number, unknown> = {};
for (const p of [7, 30, 90]) insights[p] = await cachedInsights(id, sf, p);
const brief = await summarize(id, insights[30] as never);

const b = { question: '', drill_soql: '', series_key: '', date_field: 'CreatedDate', format: 'number', size: 'half' } as const;
const tiles = await runTiles(sf, [
  { ...b, id: 't1', title: 'Open pipeline', soql: 'SELECT SUM(Amount) amount FROM Opportunity WHERE IsClosed = false', chart: 'kpi', label_key: '', value_key: 'amount', format: 'currency', size: 'third' },
  { ...b, id: 't2', title: 'Open deals', soql: 'SELECT COUNT(Id) cnt FROM Opportunity WHERE IsClosed = false', chart: 'kpi', label_key: '', value_key: 'cnt', size: 'third' },
  { ...b, id: 't3', title: 'Open cases', soql: 'SELECT COUNT(Id) cnt FROM Case WHERE IsClosed = false', chart: 'kpi', label_key: '', value_key: 'cnt', size: 'third' },
  { ...b, id: 't4', title: 'Open pipeline by stage', soql: 'SELECT StageName stage, SUM(Amount) amount FROM Opportunity WHERE IsClosed = false GROUP BY StageName ORDER BY SUM(Amount) DESC', chart: 'bar', label_key: 'stage', value_key: 'amount', format: 'currency', drill_soql: 'SELECT Name, Amount, CloseDate FROM Opportunity WHERE IsClosed = false AND StageName = :label' },
  { ...b, id: 't5', title: 'Top accounts by pipeline', soql: 'SELECT Account.Name account, SUM(Amount) amount FROM Opportunity WHERE IsClosed = false GROUP BY Account.Name ORDER BY SUM(Amount) DESC LIMIT 8', chart: 'bar', label_key: 'account', value_key: 'amount', format: 'currency' },
  { ...b, id: 't6', title: 'Cases by priority and status', soql: 'SELECT Priority priority, Status status, COUNT(Id) cnt FROM Case GROUP BY Priority, Status', chart: 'stacked', label_key: 'priority', series_key: 'status', value_key: 'cnt', size: 'full' },
  { ...b, id: 't7', title: 'Biggest open deals', soql: 'SELECT Name, Account.Name, StageName, Amount, CloseDate FROM Opportunity WHERE IsClosed = false ORDER BY Amount DESC LIMIT 10', chart: 'table', label_key: '', value_key: '', format: 'currency', size: 'full' },
], 'all');

const dashboard = { id: 'd1', name: 'Sales & Service Overview', description: 'Pipeline, top accounts and case load at a glance', prompt: 'Sales and service overview', range: 'all', tiles };
const tenant = { id: 'demo-tenant', sf_org_id: '00D000000000DEMO', sf_instance_url: 'https://demo.my.salesforce.com', sf_username: 'owner@demo-company.com', setup_status: 'ready', setup_message: null, use_package: false, created_at: new Date().toISOString() };
// Demo data is public (it ships in the web app): the org's people become demo names, their emails demo addresses.
const DEMO_NAMES = ['Priya Shah', 'Sam Lee', 'Maria Gonzalez', 'Tom Reilly', 'Ana Souza', 'Dev Patel', 'Emma Clarke', 'Luis Ramirez', 'Karen Wu', 'Arjun Rao'];
const people = (await sf.query('SELECT Name, Email, Username FROM User WHERE IsActive = true ORDER BY CreatedDate LIMIT 200')).records as { Name: string; Email: string; Username: string }[];
let out = JSON.stringify({
  tenant, insights, brief: { ...brief, reused: true }, dashboard,
  dashboards: [{ id: 'd1', name: dashboard.name, description: dashboard.description, updated_at: new Date().toISOString(), tiles: tiles.length }],
});
people.forEach((u, i) => {
  const fake = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ` ${Math.floor(i / DEMO_NAMES.length) + 1}` : '');
  for (const [real, alias] of [[u.Name, fake], [u.Email, `${fake.toLowerCase().replace(/\W+/g, '.')}@demo-company.com`], [u.Username, `${fake.toLowerCase().replace(/\W+/g, '.')}@demo-company.com`]]) {
    if (real) out = out.split(real).join(alias);
  }
});
writeFileSync(new URL('../../web/src/demo/fixtures.json', import.meta.url), out);
console.log(`brief ${brief.reused ? 'reused' : `$${brief.costUsd}`}; tiles: ${tiles.map((t) => `${t.title} ${t.error ? 'ERROR ' + t.error : t.rows.length}`).join(', ')}`);
await pool.end();
