import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { decrypt, encrypt } from '../crypto.js';
import { pool } from '../db.js';
import { forgetAccessToken, SalesforceClient } from './client.js';

// Simulates Salesforce refresh-token rotation: each refresh returns a new refresh token and the used one dies.
let valid = 'rt-0';
let refreshCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  if (String(url).endsWith('/services/oauth2/token')) {
    refreshCalls++;
    const rt = new URLSearchParams(String(init?.body)).get('refresh_token');
    await new Promise((r) => setTimeout(r, 20));
    if (rt !== valid) return new Response('{"error":"invalid_grant","error_description":"expired access/refresh token"}', { status: 400 });
    valid = `rt-${refreshCalls}`;
    return new Response(JSON.stringify({ access_token: `at-${refreshCalls}`, refresh_token: valid }), { status: 200 });
  }
  return new Response(JSON.stringify({ totalSize: 0, records: [] }), { status: 200 });
}) as typeof fetch;

const acc = await pool.query("insert into accounts (name) values ('rotation-test') returning id");
const accountId = acc.rows[0].id;
const ten = await pool.query(
  `insert into tenants (account_id, sf_org_id, sf_instance_url, refresh_token_enc, sf_client_id)
   values ($1, 'ORG_ROTATION_TEST', 'https://rotation.test', $2, 'test-client') returning id`,
  [accountId, encrypt('rt-0')],
);
const tenantId = ten.rows[0].id;

after(async () => {
  globalThis.fetch = realFetch;
  await pool.query('delete from accounts where id=$1', [accountId]);
  await pool.end();
});

test('rotated refresh tokens are stored, so later refreshes keep working', async () => {
  for (let i = 0; i < 3; i++) {
    forgetAccessToken(tenantId); // force a refresh, like a new run after the access token expired
    const sf = await SalesforceClient.forTenant(tenantId);
    await sf.query('SELECT Id FROM Case');
  }
  const { rows } = await pool.query('select refresh_token_enc, setup_status from tenants where id=$1', [tenantId]);
  assert.equal(decrypt(rows[0].refresh_token_enc), valid);
  assert.notEqual(rows[0].setup_status, 'error');
});

test('parallel requests share one refresh instead of racing with the same token', async () => {
  forgetAccessToken(tenantId);
  const before = refreshCalls;
  const clients = await Promise.all([1, 2, 3, 4].map(() => SalesforceClient.forTenant(tenantId)));
  await Promise.all(clients.map((c) => c.query('SELECT Id FROM Case')));
  assert.equal(refreshCalls - before, 1);
  const again = await SalesforceClient.forTenant(tenantId);
  await again.query('SELECT Id FROM Case'); // cached access token: no refresh at all
  assert.equal(refreshCalls - before, 1);
});
