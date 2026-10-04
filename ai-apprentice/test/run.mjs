// Dependency-free tests for the planner, Work Map and redaction.
// Run: npm test   (or: node test/run.mjs)

import assert from 'node:assert';
import * as planner from '../server/lib/planner.js';
import { buildWorkMap, toAgentJSON } from '../server/lib/workmap.js';
import { redactText } from '../server/lib/redact.js';
import { captureInvoices, teachInvoice } from '../server/lib/scenario.js';

let pass = 0;
const t = (name, fn) => { try { fn(); pass++; console.log('  ✓ ' + name); } catch (e) { console.error('  ✗ ' + name + '\n    ' + e.message); process.exitCode = 1; } };

console.log('\nplanner — what to ask');
t('capex on equipment -> judgment question', () => {
  const inv = { id: 'INV-4471', category: 'equipment', amount: 7500, cc: '0400' };
  const q = planner.questionFor('cc', inv);
  assert.ok(q && /capex/i.test(q.q) && q.guardrail === false);
});
t('big equipment left on opex -> guardrail question', () => {
  const inv = { id: 'INV-4471', category: 'equipment', amount: 7500, cc: '4711' };
  const q = planner.questionFor('cc', inv);
  assert.ok(q && q.guardrail === true);
});
t('hold -> guardrail question', () => {
  const q = planner.questionFor('action', { id: 'INV-4473', action: 'hold' });
  assert.ok(q && q.guardrail === true && /held/i.test(q.q));
});
t('escalate -> guardrail question', () => {
  const q = planner.questionFor('action', { id: 'INV-4472', action: 'escalate' });
  assert.ok(q && q.guardrail === true);
});
t('non-trigger -> no question', () => {
  assert.strictEqual(planner.questionFor('cc', { id: 'X', category: 'services', cc: '4711', amount: 100 }), null);
});

console.log('\nplanner — when to ask');
t('does not speak before the pause window', () => {
  const sess = { queued: { q: '?' }, speaking: false, pending: null, typing: false, lastActivity: 0 };
  assert.strictEqual(planner.shouldSpeak(sess, 1000), false);
});
t('speaks after the pause window', () => {
  const sess = { queued: { q: '?' }, speaking: false, pending: null, typing: false, lastActivity: 0 };
  assert.strictEqual(planner.shouldSpeak(sess, planner.constants.PAUSE_MS + 50), true);
});
t('stays quiet while typing', () => {
  const sess = { queued: { q: '?' }, speaking: false, pending: null, typing: true, lastActivity: 0 };
  assert.strictEqual(planner.shouldSpeak(sess, 999999), false);
});
t('one question at a time (pending blocks)', () => {
  const sess = { queued: { q: '?' }, speaking: false, pending: { q: 'prev' }, typing: false, lastActivity: 0 };
  assert.strictEqual(planner.shouldSpeak(sess, 999999), false);
});

console.log('\nplanner — understanding + debrief');
t('not understood until every step has reason + guardrail', () => {
  const inv = captureInvoices().map((i) => ({ ...i, action: i.truth.action, cc: i.truth.cc }));
  assert.strictEqual(planner.isUnderstood(inv, []), false);
  const qa = [];
  for (const i of inv) { qa.push({ invId: i.id, guardrail: false, a: 'r' }); qa.push({ invId: i.id, guardrail: true, a: 'g' }); }
  assert.strictEqual(planner.isUnderstood(inv, qa), true);
});
t('debrief asks about uncovered invoices', () => {
  const inv = captureInvoices().map((i) => ({ ...i, action: i.truth.action, cc: i.truth.cc }));
  const qs = planner.debriefQuestions(inv, []);
  assert.ok(qs.length >= inv.length * 2); // reason + guardrail per invoice, plus a general one
});

console.log('\nplanner — teach');
t('wrong cost center is caught before save', () => {
  const v = planner.evaluateTeachDecision(teachInvoice(), { cc: '4711' });
  assert.strictEqual(v.ok, false);
  assert.ok(/capex/i.test(v.question));
});
t('correct cost center passes', () => {
  const v = planner.evaluateTeachDecision(teachInvoice(), { cc: '0400' });
  assert.strictEqual(v.ok, true);
});

console.log('\nwork map');
t('builds one step per processed invoice with guardrails', () => {
  const invoices = captureInvoices().map((i) => ({ ...i, cc: i.truth.cc, action: i.truth.action }));
  const sess = { invoices, qa: [{ invId: 'INV-4471', guardrail: false, a: 'Equipment over 5000 is capex' }], events: [{ t: 3000, text: 'INV-4471 cost center changed (empty) -> 0400' }] };
  const steps = buildWorkMap(sess);
  assert.strictEqual(steps.length, 3);
  assert.ok(steps.every((s) => s.guardrail && s.hasGuard));
  assert.ok(steps[0].reason.includes('5000'));
});
t('agent JSON has instructions + steps', () => {
  const invoices = captureInvoices().map((i) => ({ ...i, cc: i.truth.cc, action: i.truth.action }));
  const json = toAgentJSON({ invoices, qa: [], events: [] });
  assert.ok(json.agent_instructions && json.steps.length === 3);
});

console.log('\nredaction');
t('masks supplier, money and email', () => {
  const out = redactText('Baumann Maschinen GmbH billed €7.500 to a@b.com', true);
  assert.ok(!out.includes('Baumann') && !out.includes('7.500') && !out.includes('a@b.com'));
});
t('no-op when disabled', () => {
  assert.strictEqual(redactText('Weber Supplies', false), 'Weber Supplies');
});

console.log(`\n${pass} checks passed.\n`);
