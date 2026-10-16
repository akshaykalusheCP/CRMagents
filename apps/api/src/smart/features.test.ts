import assert from 'node:assert/strict';
import { test } from 'node:test';
import { originAllowed } from '../agent/publicChat.js';
import { changeLines } from '../salesforce/audit.js';
import { newRecordPage, withRecordCards, withUtilityPanel } from '../salesforce/pages.js';
import { looksScanned } from '../knowledge/store.js';
import { stripHtml } from '../knowledge/sync.js';

test('website chat: only the listed websites may use it', () => {
  assert.equal(originAllowed('https://acme.com', ''), true); // none listed: any
  assert.equal(originAllowed('https://acme.com', 'https://acme.com, https://help.acme.com'), true);
  assert.equal(originAllowed('https://evil.com', 'https://acme.com'), false);
  assert.equal(originAllowed('https://support.acme.com', '*.acme.com'), true);
  assert.equal(originAllowed('http://support.acme.com', '*.acme.com'), false); // wildcards need https
  assert.equal(originAllowed(undefined, 'https://acme.com'), false);
});

test('agent activity lines say what changed, skipping previews and rejected steps', () => {
  const lines = changeLines([
    { type: 'sf.updateRecord', label: 'Update Case', status: 'ok', output: { success: true, changed: { Priority: 'High' } } },
    { type: 'sf.createTask', label: 'Create task', status: 'ok', output: { id: '00T1' }, iteration: 2 },
    { type: 'sf.updateRecord', label: 'Preview', status: 'ok', output: { wouldDo: 'Update' } },
    { type: 'sf.updateRecord', label: 'Rejected', status: 'ok', output: { approved: false, skipped: true } },
    { type: 'ai.agent', label: 'AI', status: 'ok', output: { text: 'x' } },
  ]);
  assert.deepEqual(lines, ['Update Case: Priority = High', 'Create task (item 3) [00T1]']);
});

test('page setup: utility item once, cards at the top of the side column', () => {
  const bar = withUtilityPanel({ masterLabel: 'Sales', type: 'UtilityBar', flexiPageRegions: [{ name: 'utilityItems', type: 'Region', itemInstances: [] }] });
  assert.equal(bar.flexiPageRegions[0].itemInstances!.length, 1);
  assert.equal(withUtilityPanel(bar).flexiPageRegions[0].itemInstances!.length, 1);
  const page = withRecordCards({ masterLabel: 'Case', type: 'RecordPage', flexiPageRegions: [
    { name: 'main', type: 'Region', itemInstances: [] },
    { name: 'sidebar', type: 'Region', itemInstances: [{ componentInstance: { componentName: 'force:relatedListContainer', identifier: 'r' } }] },
  ] });
  assert.deepEqual(page.flexiPageRegions[1].itemInstances!.map((i) => i.componentInstance!.componentName.replace(/^c:/, '')), ['crmSuggestions', 'crmAgentsPanel', 'force:relatedListContainer']);
  assert.equal(newRecordPage('Case').sobjectType, 'Case');
});

test('scanned PDFs are recognised; article HTML becomes text', () => {
  assert.equal(looksScanned('## Page 1\n\n \n\n## Page 2\n\n12'), true);
  assert.equal(looksScanned('## Page 1\n\nRestart the router and check the cables before calling support.'), false);
  assert.equal(stripHtml('<h2>Fix</h2><p>Restart&nbsp;it</p><ul><li>Step one</li></ul>'), '## Fix\nRestart it\n- Step one');
});

test('impact counts real work only: previews, rejected and skipped steps do not count', async () => {
  const { countSteps } = await import('../insights/impact.js');
  const c = countSteps([
    { type: 'trigger.salesforce', status: 'ok', output: {} },
    { type: 'ai.classify', status: 'ok', output: { category: 'Billing' } },
    { type: 'logic.approval', status: 'ok', output: { approved: true } },
    { type: 'sf.updateRecord', status: 'ok', output: { success: true } },
    { type: 'sf.createTask', status: 'ok', output: { wouldDo: 'Create Task' } },
    { type: 'sf.updateRecord', status: 'ok', output: { approved: false, skipped: true } },
    { type: 'sf.emailReply', status: 'ok', output: { sent: true } },
    { type: 'sf.emailReply', status: 'ok', output: { sent: false, suggestionId: 'x' } },
    { type: 'sf.createRecord', status: 'error', output: {} },
  ]);
  assert.deepEqual(c, { changes: 1, aiSteps: 1, repliesSent: 1, approved: 1, rejected: 0 });
});
