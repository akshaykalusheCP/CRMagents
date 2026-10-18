import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pool } from '../db.js';
import { SalesforceClient } from './client.js';
import { runTiles } from '../insights/dashboards.js';

// Acting as each person: their own Salesforce login, and nothing one person saw is served to another.

test('a person without a linked Salesforce login is asked to link it (409, sf_link_required)', async () => {
  const { rows } = await pool.query('select id from tenants limit 1');
  if (!rows[0]) return; // no connected org in this database
  await assert.rejects(SalesforceClient.forPerson(rows[0].id, '00000000-0000-0000-0000-0000000000aa'), (e: Error & { statusCode?: number; code?: string }) => e.statusCode === 409 && e.code === 'sf_link_required');
});

test("dashboard tiles: one person's cached results are never served to another person", async () => {
  // Two people in the same org see different records for the same query (their Salesforce sharing differs).
  const fake = (personId: string | undefined, records: unknown[]) => ({ tenantId: 'tile-cache-test', personId, query: async () => ({ totalSize: records.length, records }) }) as unknown as SalesforceClient;
  const tile = { id: 't1', title: 'Deals', question: '', soql: 'SELECT Name FROM Opportunity', chart: 'table', label_key: '', value_key: '', series_key: '', date_field: '', format: 'number', size: 'full', drill_soql: '' } as never;
  const a = await runTiles(fake('person-a', [{ Name: 'Secret deal' }, { Name: 'Shared deal' }]), [tile], 'ALL_TIME' as never);
  const b = await runTiles(fake('person-b', [{ Name: 'Shared deal' }]), [tile], 'ALL_TIME' as never);
  assert.ok(JSON.stringify(a).includes('Secret deal'));
  assert.ok(!JSON.stringify(b).includes('Secret deal'), 'person B must not get person A\'s cached rows');
  await pool.end();
});
