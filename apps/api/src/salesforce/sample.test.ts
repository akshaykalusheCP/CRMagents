import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fitter, sampleAllowed, summarize } from './sample.js';
import type { SalesforceClient } from './client.js';

const org = (o: Record<string, unknown>) => ({ query: async () => ({ records: [o] }) }) as unknown as SalesforceClient;

test('sample data only goes into sandboxes, Developer Edition and trial orgs', async () => {
  assert.equal((await sampleAllowed(org({ OrganizationType: 'Developer Edition', IsSandbox: false }))).allowed, true);
  assert.equal((await sampleAllowed(org({ OrganizationType: 'Enterprise Edition', IsSandbox: true }))).allowed, true);
  assert.equal((await sampleAllowed(org({ OrganizationType: 'Enterprise Edition', IsSandbox: false, TrialExpirationDate: '2026-11-01' }))).allowed, true);
  const prod = await sampleAllowed(org({ OrganizationType: 'Enterprise Edition', IsSandbox: false, TrialExpirationDate: null }));
  assert.equal(prod.allowed, false);
  assert.equal(prod.kind, 'Enterprise Edition');
});

test('fields the org lacks, cannot set, or picklist values it does not use are dropped', () => {
  const fit = fitter([
    { name: 'Name', label: 'Name', type: 'string', updateable: true, createable: true },
    { name: 'Status', label: 'Status', type: 'picklist', updateable: true, createable: true, picklistValues: [{ value: 'New', active: true }, { value: 'Old', active: false }] },
    { name: 'Formula__c', label: 'F', type: 'string', updateable: false, createable: false },
  ]);
  assert.deepEqual(fit({ Name: 'A', Status: 'New', Formula__c: 'x', Missing__c: 1, Empty: '' }), { Name: 'A', Status: 'New' });
  assert.deepEqual(fit({ Name: 'A', Status: 'Old' }), { Name: 'A' });
  assert.deepEqual(fit({ Name: 'A', Status: 'Gone' }), { Name: 'A' });
});

test('repeated failures are listed once with a count', () => {
  assert.deepEqual(summarize(['Contact: rule A', 'Contact: rule A', 'Lead: rule B']), ['2 × Contact: rule A', 'Lead: rule B']);
});
