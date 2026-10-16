import assert from 'node:assert/strict';
import { test } from 'node:test';
import { simulated, wordChecks } from './tests.js';

test('assistant tests: word rules are case-insensitive and explain what failed', () => {
  assert.deepEqual(wordChecks('Refunds take 5-7 business days.', ['5-7 business days', 'refund'], ['guarantee']), []);
  assert.deepEqual(wordChecks('We guarantee it.', ['refund'], ['Guarantee']), ['Missing "refund"', 'Says "Guarantee", which it must not']);
  assert.deepEqual(wordChecks('anything', ['  ', ''], []), []);
});

test('assistant tests: nothing is changed or sent during a test, reads still run', () => {
  assert.equal(simulated('soql_query', { q: 'SELECT Id FROM Case' }), undefined);
  assert.equal(simulated('search_knowledge', { query: 'x' }), undefined);
  for (const t of ['update_record', 'create_record', 'delete_record', 'open_case', 'talk_to_person', 'send_code', 'run_org_action']) {
    assert.match(simulated(t, { a: 1 }) ?? '', /was not run/, t);
  }
});
