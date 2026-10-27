import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeSoql } from './ai.js';

test('AI-written queries are read-only and size-capped', () => {
  assert.equal(safeSoql('SELECT Id FROM Case'), 'SELECT Id FROM Case LIMIT 200');
  assert.equal(safeSoql('SELECT Id FROM Case LIMIT 5000;'), 'SELECT Id FROM Case LIMIT 200');
  assert.equal(safeSoql('SELECT SUM(Amount) amount FROM Opportunity WHERE IsClosed = false'), 'SELECT SUM(Amount) amount FROM Opportunity WHERE IsClosed = false');
  assert.equal(safeSoql('SELECT StageName, COUNT(Id) c FROM Opportunity GROUP BY StageName'), 'SELECT StageName, COUNT(Id) c FROM Opportunity GROUP BY StageName LIMIT 200');
  assert.equal(safeSoql('select count(Id) n from Case group by Status'), 'select count(Id) n from Case group by Status LIMIT 200');
  assert.equal(safeSoql('select Id from Case limit 10'), 'select Id from Case limit 10');
  assert.throws(() => safeSoql('DELETE FROM Case'), /Only SELECT/);
  assert.throws(() => safeSoql("SELECT Id FROM Case WHERE Id IN (SELECT Id FROM Case) update Case set x"), /read-only/);
  // keywords inside string values are fine
  assert.equal(safeSoql("SELECT Id FROM Case WHERE Subject = 'please update me' LIMIT 5"), "SELECT Id FROM Case WHERE Subject = 'please update me' LIMIT 5");
});

test('deal risk: transparent rules with reasons', async () => {
  const { scoreDeal } = await import('./metrics.js');
  const today = Date.parse('2026-10-09T00:00:00Z');
  const healthy = scoreDeal({ CloseDate: '2026-12-01', LastActivityDate: '2026-10-05', Probability: 60, StageName: 'Proposal' }, today);
  assert.equal(healthy.score, 0);
  const bad = scoreDeal({ CloseDate: '2025-08-21', LastActivityDate: undefined, StageName: 'Needs Analysis', LastStageChangeDate: '2025-06-01', PushCount: 3 }, today);
  assert.equal(bad.score, 90);
  assert.deepEqual(bad.reasons.map((r) => r.split(' ')[0]), ['close', 'no', 'in', 'close']);
  const soonLow = scoreDeal({ CloseDate: '2026-10-15', LastActivityDate: '2026-10-08', Probability: 20 }, today);
  assert.equal(soonLow.score, 15);
  assert.match(soonLow.reasons[0], /closing in 6 days at 20% probability/);
});

test('dashboard date filter is injected safely into any query shape', async () => {
  const { applyDateFilter } = await import('./dashboards.js');
  assert.equal(applyDateFilter('SELECT COUNT(Id) n FROM Lead', 'CreatedDate', 'THIS_YEAR'), 'SELECT COUNT(Id) n FROM Lead WHERE CreatedDate = THIS_YEAR');
  assert.equal(
    applyDateFilter('SELECT StageName, SUM(Amount) s FROM Opportunity WHERE IsWon = true OR Amount > 5 GROUP BY StageName ORDER BY SUM(Amount) DESC LIMIT 10', 'CloseDate', 'LAST_N_DAYS:90'),
    'SELECT StageName, SUM(Amount) s FROM Opportunity WHERE CloseDate = LAST_N_DAYS:90 AND (IsWon = true OR Amount > 5) GROUP BY StageName ORDER BY SUM(Amount) DESC LIMIT 10',
  );
  // keywords inside strings and subqueries are ignored
  assert.equal(
    applyDateFilter("SELECT Name FROM Account WHERE Name = 'x WHERE y' AND Id IN (SELECT AccountId FROM Case WHERE IsClosed = false) LIMIT 5", 'CreatedDate', 'THIS_MONTH'),
    "SELECT Name FROM Account WHERE CreatedDate = THIS_MONTH AND (Name = 'x WHERE y' AND Id IN (SELECT AccountId FROM Case WHERE IsClosed = false)) LIMIT 5",
  );
  assert.equal(applyDateFilter('SELECT Id FROM Case', 'CreatedDate', 'all'), 'SELECT Id FROM Case');
  assert.equal(applyDateFilter('SELECT Id FROM Case', '', 'THIS_YEAR'), 'SELECT Id FROM Case');
  assert.throws(() => applyDateFilter('SELECT Id FROM Case', 'CreatedDate; DROP', 'THIS_YEAR'), /Invalid date field/);
  assert.throws(() => applyDateFilter('SELECT Id FROM Case', 'CreatedDate', 'TODAY OR Id != null'), /Invalid date range/);
});

test('impact per task: AI cost against the same work by a person', async () => {
  const { perTask } = await import('./impact.js');
  assert.equal(perTask(0, 1, 1), null);
  const p = perTask(100, 0.2, 150)!;
  assert.equal(p.aiUsd, 0.002);
  assert.equal(p.byHandUsd, 1.5);
  assert.ok(Math.abs((p.times ?? 0) - 750) < 1e-6);
  assert.equal(perTask(10, 0, 5)!.times, null); // free (all reused): no ratio
});
