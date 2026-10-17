import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workflow } from '@crmagents/shared';
import { scheduledRuns, stepsCost } from './costplan.js';

const n = (id: string, type: string, config: Record<string, unknown> = {}) => ({ id, type, position: { x: 0, y: 0 }, config });
const e = (s: string, t: string, h = 'out') => ({ id: `${s}-${t}`, source: s, target: t, sourceHandle: h });

test('costs: AI steps add up; steps inside a loop count per record; web research costs more', () => {
  const g: Workflow = {
    nodes: [n('t', 'trigger.schedule', { every: 'week' }), n('q', 'sf.query'), n('l', 'logic.loop'), n('c', 'ai.classify'), n('w', 'ai.agent', { tools: ['web_search'] }), n('o', 'util.output')],
    edges: [e('t', 'q'), e('q', 'l'), e('l', 'c', 'item'), e('l', 'o', 'done'), e('c', 'w')],
  };
  assert.equal(Math.round(stepsCost(g) * 10000) / 10000, Math.round((0.0003 + 0.05) * 10 * 10000) / 10000);
  assert.equal(scheduledRuns(g), 4.3);
  assert.equal(stepsCost({ nodes: [n('t', 'trigger.salesforce'), n('x', 'ai.extract')], edges: [e('t', 'x')] }), 0.004);
});
