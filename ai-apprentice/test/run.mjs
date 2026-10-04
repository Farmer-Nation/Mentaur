// Dependency-free tests for the planner, Work Map and redaction.
// Run: npm test   (or: node test/run.mjs)

import assert from 'node:assert';
import * as planner from '../server/lib/planner.js';
import { buildWorkMap, toAgentJSON } from '../server/lib/workmap.js';
import { redactText } from '../server/lib/redact.js';
import { captureInvoices, teachInvoice } from '../server/lib/scenario.js';
import * as rooms from '../server/lib/room.js';

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
t('question mode pause blocks a queued question', () => {
  const sess = { queued: { q: '?' }, speaking: false, pending: null, typing: false, questionsPaused: true, lastActivity: 0 };
  assert.strictEqual(planner.shouldSpeak(sess, 999999), false);
});
t('periodic idle prompt uses the shorter live-share quiet gap', () => {
  const sess = { queued: { q: '?', source: 'idle' }, speaking: false, pending: null, typing: false, lastActivity: 0 };
  assert.strictEqual(planner.shouldSpeak(sess, planner.constants.IDLE_PROMPT_PAUSE_MS + 25), true);
});

console.log('\nlive vision room state');
t('Claude activity summaries are persisted as chat and suggestions keep three prompts', () => {
  const code = rooms.createRoom(); const room = rooms.getRoom(code);
  rooms.applyVisionAnalysis(room, {
    summary: 'Browser | Reviewing a pricing page | Comparing plan limits',
    activitySummary: 'The guide is comparing plan limits before choosing an option.',
    events: [],
    studentQuestions: ['Why this plan?', 'What limit matters most?', 'What would change your choice?'],
    question: { q: 'What limit matters most to this choice?', key: 'plan-limit', guardrail: false },
  });
  assert.strictEqual(room.chat.at(-1).from, 'activity');
  assert.match(room.chat.at(-1).text, /comparing plan limits/i);
  assert.strictEqual(room.suggestions.length, 3);
  assert.strictEqual(room.queued, null); // ordinary observation waits for the idle cadence
});
t('activity summaries are capped at one per minute', () => {
  assert.ok(rooms.liveCadence.SUMMARY_MIN_MS >= 60000);
  const code = rooms.createRoom(); const room = rooms.getRoom(code);
  rooms.applyVisionAnalysis(room, { activitySummary: 'First live activity summary.' });
  rooms.applyVisionAnalysis(room, { activitySummary: 'A different summary a few seconds later.' });
  assert.strictEqual(room.chat.filter((m) => m.from === 'activity').length, 1);
});
t('idle questions stay eligible on arbitrary shared tabs without demo events', () => {
  const code = rooms.createRoom(); const room = rooms.getRoom(code);
  room.shareState = { sharing: true, paused: false };
  room.latestFrame = 'data:image/jpeg;base64,shared-tab-frame';
  const at = Math.max(rooms.liveCadence.IDLE_QUESTION_MS, rooms.liveCadence.IDLE_QUESTION_COOLDOWN_MS) + 1;
  assert.strictEqual(rooms.shouldQueueIdleQuestion(room, at), true);
  room.questionsPaused = true;
  assert.strictEqual(rooms.shouldQueueIdleQuestion(room, at), false);
});
t('high-value vision questions can still queue immediately and pause clears them', () => {
  const code = rooms.createRoom(); const room = rooms.getRoom(code);
  rooms.applyVisionAnalysis(room, {
    summary: 'ERP | Approval warning visible | Reviewing an exception', activitySummary: '',
    events: [{ text: 'Approval warning is visible', kind: 'warning', importance: 'high' }],
    studentQuestions: [],
    question: { q: 'When would you stop instead of approving this?', key: 'approval-warning', guardrail: true },
  });
  assert.ok(room.queued && room.queued.source === 'vision');
  rooms.setShareState(room, { sharing: true, paused: true });
  assert.strictEqual(room.queued, null);
});

console.log('\nplanner — understanding + debrief');
t('teacher and student keep independent language preferences', () => {
  const code = rooms.createRoom(); const room = rooms.getRoom(code);
  rooms.setGuideLanguage(room, 'en');
  rooms.setStudentLanguage(room, 'vi');
  assert.strictEqual(room.guideLanguage, 'en');
  assert.strictEqual(room.studentLanguage, 'vi');
  assert.strictEqual(rooms.roomView(room).studentLanguage, 'vi');
});
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
