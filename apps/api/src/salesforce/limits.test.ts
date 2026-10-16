import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workflow } from '@crmagents/shared';
import { fromCreateEvent, prefetchFields, usePrefetched } from '../engine/prefetch.js';
import { SalesforceClient, csvToRecords, primeAccessToken } from './client.js';
import { parseCsv } from './csv.js';
import { allowed, apiLevel, assertBudget, levelOf, parseLimitInfo, pollMinutes, recordUsage } from './limits.js';

test('API usage: parsed from the header, levels and what may run at each', () => {
  assert.deepEqual(parseLimitInfo('api-usage=1234/15000'), { used: 1234, max: 15000 });
  assert.deepEqual(parseLimitInfo('per-app-api-usage=2/250(appName=x), api-usage=9/100'), { used: 9, max: 100 });
  assert.equal(parseLimitInfo(null), null);
  assert.equal(levelOf({ used: 49, max: 100, at: 0 }), 0);
  assert.equal(levelOf({ used: 50, max: 100, at: 0 }), 1);
  assert.equal(levelOf({ used: 80, max: 100, at: 0 }), 2);
  assert.equal(levelOf({ used: 95, max: 100, at: 0 }), 3);
  // Optional work stops first, record checks near the end, essential work never.
  assert.deepEqual([0, 1, 2, 3].map((l) => allowed(l, 'background')), [true, true, false, false]);
  assert.deepEqual([0, 1, 2, 3].map((l) => allowed(l, 'trigger')), [true, true, true, false]);
  assert.deepEqual([0, 1, 2, 3].map((l) => allowed(l, 'essential')), [true, true, true, true]);
});

test('record checks slow down when quiet and when the org runs low', () => {
  assert.equal(pollMinutes(0, 0), 1);
  assert.equal(pollMinutes(0, 10), 2);
  assert.equal(pollMinutes(0, 30), 5);
  assert.equal(pollMinutes(1, 0), 2);
  assert.equal(pollMinutes(2, 0), 10);
});

test('optional work is refused with a clear message near the limit', () => {
  recordUsage('t-budget', 'api-usage=85/100');
  assert.equal(apiLevel('t-budget'), 2);
  assert.throws(() => assertBudget('t-budget', 'background'), /85% of its daily API allowance/);
  assert.doesNotThrow(() => assertBudget('t-budget', 'trigger'));
  assert.doesNotThrow(() => assertBudget('t-budget', 'essential'));
});

const g = (fields: string, extra: Partial<{ id: string; sobject: string }> = {}): Workflow => ({
  nodes: [{ id: 'sf_get_1', type: 'sf.getRecord', position: { x: 0, y: 0 }, config: { sobject: extra.sobject ?? 'Case', id: extra.id ?? '{{trigger.recordId}}', fields } }],
  edges: [],
});

test('prefetch: the polling query or a create event can supply the record', () => {
  assert.deepEqual(prefetchFields(g('Subject, Status'), 'Case'), ['Subject', 'Status']);
  assert.equal(prefetchFields(g(''), 'Case'), null); // reads every field: fetches it itself
  assert.deepEqual(prefetchFields(g('Subject', { sobject: 'Lead' }), 'Case'), []);

  const trigger = { recordId: '500A', objectApiName: 'Case', prefetched: { fields: ['Subject', 'Status', 'Description'], record: { Subject: 'Wifi', Status: 'New' } } };
  assert.deepEqual(usePrefetched(trigger, 'Case', '500A', ['Subject', 'Description']), { Id: '500A', Subject: 'Wifi' });
  assert.equal(usePrefetched(trigger, 'Case', '500A', ['Priority']), undefined); // not fetched
  assert.equal(usePrefetched(trigger, 'Case', '500B', ['Subject']), undefined); // another record
  assert.equal(usePrefetched(trigger, 'Case', '500A', []), undefined); // "all fields"

  assert.deepEqual(fromCreateEvent({ Subject: 'Wifi', Priority: 'High' }, ['Subject', 'Description']), { fields: ['Subject', 'Description'], record: { Subject: 'Wifi' } });
  assert.equal(fromCreateEvent({ Name: { FirstName: 'A', LastName: 'B' } }, ['Name']), null); // compound: fetch instead
});

test('CSV: quotes, commas, newlines; relationship columns become nested', () => {
  assert.deepEqual(parseCsv('a,b\n"x, y","he said ""hi""\nbye"\n'), [['a', 'b'], ['x, y', 'he said "hi"\nbye']]);
  assert.deepEqual(csvToRecords('"Id","Account.Name","Empty"\n"001","Acme",""\n'), [{ Id: '001', Account: { Name: 'Acme' } }]);
});

// ---- the client against a fake Salesforce ----
function fakeOrg(handler: (method: string, url: string, body: any) => { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }) {
  const calls: { method: string; url: string; body: any }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    let body: any = init.body;
    try { body = body ? JSON.parse(String(body)) : undefined; } catch { /* csv */ }
    calls.push({ method, url: String(url), body });
    const r = handler(method, String(url), body);
    const headers = new Headers({ 'sforce-limit-info': 'api-usage=10/15000', ...(r.headers ?? {}) });
    return new Response(r.text ?? JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers });
  }) as typeof fetch;
  const sf = Object.assign(Object.create(SalesforceClient.prototype), { tenantId: 't-fake', accountId: 'a', instanceUrl: 'https://x.my.salesforce.com', calls: 0, queued: [] }) as SalesforceClient;
  primeAccessToken('t-fake', 'token');
  return { sf, calls, restore: () => { globalThis.fetch = real; } };
}

test('queries started together go as one composite batch call', async () => {
  const { sf, calls, restore } = fakeOrg((method, url, body) => {
    if (url.endsWith('/composite/batch')) return { json: { results: body.batchRequests.map((_: unknown, i: number) => ({ statusCode: i === 2 ? 400 : 200, result: i === 2 ? [{ message: 'bad field' }] : { totalSize: i, done: true, records: [{ attributes: {}, n: i }] } })) } };
    return { json: { totalSize: 1, done: true, records: [] } };
  });
  try {
    const rs = await Promise.allSettled([0, 1, 2, 3].map((i) => sf.query(`SELECT COUNT() FROM Case WHERE x = ${i}`)));
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/composite\/batch$/);
    assert.equal(rs[0].status, 'fulfilled');
    assert.deepEqual((rs[1] as PromiseFulfilledResult<any>).value.records, [{ n: 1 }]);
    assert.equal(rs[2].status, 'rejected'); // one bad query doesn't fail the others
    assert.equal(rs[3].status, 'fulfilled');
    await sf.query('SELECT Id FROM Case'); // alone: a plain GET
    assert.equal(calls[1].method, 'GET');
    assert.equal(apiLevel('t-fake'), 0);
  } finally { restore(); }
});

test('queryAll follows pages, and switches to Bulk API 2.0 for large results', async () => {
  let pages = 0;
  const small = fakeOrg((_m, url) => {
    if (url.includes('/query/01g')) { pages++; return { json: { records: [{ Id: `p${pages}` }], nextRecordsUrl: pages < 2 ? '/services/data/v67.0/query/01g-4000' : undefined } }; }
    return { json: { totalSize: 3, done: false, records: [{ Id: 'a' }], nextRecordsUrl: '/services/data/v67.0/query/01g-2000' } };
  });
  try {
    const r = await small.sf.queryAll('SELECT Id FROM Case');
    assert.deepEqual(r.records.map((x) => x.Id), ['a', 'p1', 'p2']);
    assert.equal(r.via, 'rest');
  } finally { small.restore(); }

  let polls = 0;
  const big = fakeOrg((method, url) => {
    if (url.includes('/jobs/query') && method === 'POST') return { json: { id: '750J' } };
    if (url.endsWith('/jobs/query/750J')) return { json: { state: ++polls < 2 ? 'InProgress' : 'JobComplete' } };
    if (url.includes('/jobs/query/750J/results') && !url.includes('locator=')) return { text: '"Id"\n"r1"\n"r2"\n', headers: { 'sforce-locator': 'L2' } };
    if (url.includes('locator=L2')) return { text: '"Id"\n"r3"\n', headers: { 'sforce-locator': 'null' } };
    return { json: { totalSize: 120_000, done: false, records: [{ Id: 'r1' }], nextRecordsUrl: '/services/data/v67.0/query/01g-2000' } };
  });
  try {
    const r = await big.sf.queryAll('SELECT Id FROM Case', 200_000);
    assert.equal(r.via, 'bulk');
    assert.deepEqual(r.records.map((x) => x.Id), ['r1', 'r2', 'r3']);
    assert.ok(big.calls.length <= 6, `${big.calls.length} calls`);
  } finally { big.restore(); }
});

test('saveMany: 450 updates in 3 collection calls, each record succeeds or fails on its own', async () => {
  const { sf, calls, restore } = fakeOrg((_m, _url, body) => ({ json: body.records.map((r: any) => (r.Id === '500-7' ? { success: false, errors: [{ statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Reason is required' }] } : { id: r.Id, success: true, errors: [] })) }));
  try {
    const ops = Array.from({ length: 450 }, (_, i) => ({ kind: 'update' as const, sobject: 'Case', id: `500-${i}`, fields: { Status: 'Working' } }));
    const r = await sf.saveMany(ops);
    assert.equal(calls.length, 3);
    assert.ok(calls.every((c) => c.method === 'PATCH' && c.url.endsWith('/composite/sobjects') && c.body.allOrNone === false));
    assert.equal(r.filter((x) => x.ok).length, 449);
    assert.match(r[7].error!, /Reason is required/);
  } finally { restore(); }
});

test('the whole daily allowance used: a clear error, and the org is marked as out', async () => {
  const { sf, restore } = fakeOrg(() => ({ status: 403, text: '[{"errorCode":"REQUEST_LIMIT_EXCEEDED","message":"TotalRequests Limit exceeded."}]' }));
  try {
    await assert.rejects(sf.getRecord('Case', '500A'), /used its whole daily API allowance/);
    assert.equal(apiLevel('t-fake'), 3);
  } finally { restore(); }
});
