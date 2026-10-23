import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { pool } from '../db.js';
import { addDocument, addSummarySection, capPerDoc, deleteDocument, searchKnowledge } from './store.js';

after(() => pool.end());

test('search: at most 3 sections from one document, best first', () => {
  const h = (docId: string, n: number) => ({ docId, n });
  const out = capPerDoc([h('a', 1), h('a', 2), h('a', 3), h('a', 4), h('b', 5), h('a', 6), h('c', 7)], 5);
  assert.deepEqual(out.map((x) => x.n), [1, 2, 3, 5, 7]);
});

test('search: a guide is found by the other words in its summary, and one long guide cannot fill every result', async () => {
  const { rows } = await pool.query('select id from accounts limit 1');
  if (!rows[0]) return;
  const a = rows[0].id as string;
  const long = Array.from({ length: 6 }, (_, i) => `## Printer step ${i + 1}\n\nRestart the printer and check the printer tray ${i}.`).join('\n\n');
  const d1 = await addDocument(a, { title: 'ZZ test printer manual', kind: 'text', text: long });
  const d2 = await addDocument(a, { title: 'ZZ test office guide', kind: 'text', text: '## Printing\n\nThe printer is on floor 2.' });
  try {
    const hits = await searchKnowledge(a, 'printer', 5);
    const fromLong = hits.filter((x) => x.docId === d1.id).length;
    assert.ok(fromLong <= 3, `at most 3 from one document (${fromLong})`);
    assert.ok(hits.some((x) => x.docId === d2.id), 'the other guide still shows');
    assert.equal((await searchKnowledge(a, 'paper jam', 4)).filter((x) => x.docId === d1.id).length, 0);
    await addSummarySection(d1.id, a, 'Summary: How to fix printing problems.\n\nAlso searched as: paper jam, printer offline, cannot print');
    const viaSummary = await searchKnowledge(a, 'paper jam', 4);
    assert.ok(viaSummary.some((x) => x.docId === d1.id && x.heading === 'Summary'), 'found through the summary words');
  } finally {
    await deleteDocument(a, d1.id).catch(() => undefined);
    await deleteDocument(a, d2.id).catch(() => undefined);
  }
});
