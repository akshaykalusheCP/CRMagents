import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nsFilter, pn, pnFields } from './pkg.js';

test('package names: prefixed in a namespaced package, unchanged in the original one', () => {
  assert.equal(pn('', 'CRMagents_Config__c'), 'CRMagents_Config__c');
  assert.equal(pn('nimbus', 'CRMagents_Config__c'), 'nimbus__CRMagents_Config__c');
  assert.equal(pn('nimbus', 'CRMCaseEmail'), 'nimbus__CRMCaseEmail');
  assert.deepEqual(pnFields('nimbus', { Base_Url__c: 'u', SetupOwnerId: 'x' }), { nimbus__Base_Url__c: 'u', SetupOwnerId: 'x' });
  assert.deepEqual(pnFields('', { Base_Url__c: 'u' }), { Base_Url__c: 'u' });
  assert.equal(nsFilter(''), 'NamespacePrefix = null');
  assert.equal(nsFilter("nim'bus"), "NamespacePrefix = 'nimbus'");
});
