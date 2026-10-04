// Rooms: a Guide and one or more Students share one live session.
// Any action fans out to everyone over SSE (broadcast). The background watcher
// paces the AI's questions to the Guide (one at a time, only after a pause) and
// refreshes the Student's suggested questions. After the session it builds a
// shared curriculum the Student can practice against, with the AI coaching on
// the Guide's behalf.

import crypto from 'node:crypto';
import { captureInvoices, teachInvoice } from './scenario.js';
import * as planner from './planner.js';
import { buildWorkMap, toAgentJSON } from './workmap.js';
import { phraseGuideQuestion, studentSuggestions, buildCurriculum, practiceFeedback } from './reasoning.js';

const rooms = new Map(); // code -> room
const subs = new Map(); // code -> Set<{res, role, id}>

function code4() {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => s[Math.floor(Math.random() * s.length)]).join('');
}
function now(room) { return room.created ? Date.now() - room.created : 0; }

export function createRoom() {
  let code; do { code = code4(); } while (rooms.has(code));
  const room = {
    code, created: Date.now(), phase: 'capture',
    invoices: captureInvoices(), events: [], qa: [], chat: [],
    suggestions: [], workMap: [], curriculum: null,
    pending: null, queued: null, askedKeys: new Set(),
    lastActivity: 0, typing: false, speaking: false,
    debriefQ: null, debriefIdx: -1,
    practice: {}, latestFrame: null, redact: false,
    guidePresent: false, students: 0,
  };
  rooms.set(code, room);
  return code;
}
export function getRoom(code) { return rooms.get(code); }

export function roomView(room) {
  return {
    code: room.code, phase: room.phase, invoices: room.invoices,
    events: room.events, qa: room.qa, chat: room.chat,
    suggestions: room.suggestions, coverage: planner.coverage(room.invoices, room.qa),
    workMap: room.workMap, curriculum: room.curriculum, redact: room.redact,
    presence: { guide: room.guidePresent, students: room.students },
  };
}

// ---- SSE ----
export function subscribe(code, role, res) {
  const room = rooms.get(code); if (!room) return false;
  if (!subs.has(code)) subs.set(code, new Set());
  const entry = { res, role, id: crypto.randomUUID() };
  subs.get(code).add(entry);
  updatePresence(room);
  res.on('close', () => { subs.get(code)?.delete(entry); updatePresence(room); });
  return true;
}
function updatePresence(room) {
  const set = subs.get(room.code) || new Set();
  room.guidePresent = [...set].some((e) => e.role === 'guide');
  room.students = [...set].filter((e) => e.role === 'student').length;
  broadcast(room, { type: 'presence', presence: { guide: room.guidePresent, students: room.students } });
}
function broadcast(room, event, onlyRole) {
  const set = subs.get(room.code); if (!set) return;
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const e of set) { if (onlyRole && e.role !== onlyRole) continue; try { e.res.write(line); } catch { /* dropped */ } }
}

// ---- activity + events ----
export function reportActivity(room, { typing } = {}) {
  room.lastActivity = now(room);
  if (typeof typing === 'boolean') room.typing = typing;
}
function pushEvent(room, text) {
  const ev = { t: now(room), text };
  room.events.push(ev);
  broadcast(room, { type: 'event', event: ev, invoices: room.invoices });
}

// A change from the Guide's sandbox ERP (or the vision pipeline).
export function applyChange(room, { invId, trigger, cc, action }) {
  const inv = room.invoices.find((i) => i.id === invId);
  if (!inv) return;
  if (trigger === 'open') { pushEvent(room, `${invId} opened`); return; }
  if (trigger === 'cc') { const from = inv.cc || '(empty)'; inv.cc = cc; pushEvent(room, `${invId} cost center changed ${from} -> ${cc}`); }
  if (trigger === 'action') {
    inv.action = action;
    const label = { approve: 'approved & posted', hold: 'held', escalate: 'sent for 2nd approval' }[action];
    pushEvent(room, `${invId} ${label}`);
  }
  reportActivity(room, { typing: false });
  queueGuideQuestion(room, trigger, inv);
  refreshSuggestions(room);
  maybeOfferDebrief(room);
}

// Relayed screenshot so the Student sees the Guide's real screen (vision mode).
export function pushFrame(room, dataUrl) {
  room.latestFrame = dataUrl;
  broadcast(room, { type: 'frame', frame: dataUrl }, 'student');
}

function queueGuideQuestion(room, trigger, inv) {
  if (room.pending || room.queued) return;
  const cand = planner.questionFor(trigger, inv);
  if (!cand || room.askedKeys.has(cand.key)) return;
  room.queued = cand; // released by the watcher after a pause
}

async function refreshSuggestions(room) {
  try {
    room.suggestions = await studentSuggestions(room);
    broadcast(room, { type: 'suggestions', suggestions: room.suggestions }, 'student');
  } catch { /* keep previous */ }
}

// ---- chat: either side can speak/type ----
export function postChat(room, { from, text, to }) {
  const msg = { from, text, t: now(room) };
  room.chat.push(msg);
  broadcast(room, { type: 'chat', msg });

  if (from === 'student') {
    // a student question for the guide; also captured as a clarification
    room.qa.push({ q: `(student) ${text}`, a: null, invId: null, stepKey: 'student_q', guardrail: false, t: now(room) });
    refreshSuggestions(room);
    return;
  }
  if (from === 'guide') {
    // guide speaking: if answering the AI's pending question, capture it
    if (room.pending) {
      const q = room.pending;
      room.qa.push({ q: q.q, a: text, invId: q.invId, stepKey: q.stepKey, guardrail: q.guardrail, t: now(room) });
      room.pending = null;
      broadcast(room, { type: 'ack', guardrail: q.guardrail, coverage: planner.coverage(room.invoices, room.qa) });
      if (room.phase === 'debrief') nextDebrief(room);
    } else {
      // guide answering a student's open question → attach to the latest student_q
      const open = [...room.qa].reverse().find((x) => x.stepKey === 'student_q' && x.a === null);
      if (open) open.a = text;
    }
    refreshSuggestions(room);
  }
}

export function setRedact(room, on) { room.redact = on; broadcast(room, { type: 'redact', on }); }
export function setSpeaking(room, on) { room.speaking = on; }
export function setOffRecord(room, on) { room.offRecord = on; }

// ---- debrief + teach-back (AI with the guide) ----
function maybeOfferDebrief(room) {
  if (room.invoices.every((i) => i.action) && room.phase === 'capture' && !room._debriefOffered) {
    room._debriefOffered = true;
    broadcast(room, { type: 'debrief_ready' });
  }
}
export function startDebrief(room) {
  room.phase = 'debrief';
  room.debriefQ = planner.debriefQuestions(room.invoices, room.qa);
  room.debriefIdx = -1;
  broadcast(room, { type: 'phase', phase: 'debrief' });
  nextDebrief(room);
}
function nextDebrief(room) {
  room.debriefIdx++;
  if (room.debriefIdx >= room.debriefQ.length) {
    room.phase = 'teachback';
    broadcast(room, { type: 'teachback', steps: buildWorkMap(room) });
    return;
  }
  const q = room.debriefQ[room.debriefIdx];
  room.pending = { ...q, debrief: true };
  broadcast(room, { type: 'ask', question: q.q, guardrail: q.guardrail, progress: { i: room.debriefIdx + 1, n: room.debriefQ.length } });
}
export async function confirmTeachback(room) {
  room.workMap = buildWorkMap(room);
  room.curriculum = await buildCurriculum(room);
  room.phase = 'curriculum';
  broadcast(room, { type: 'curriculum', curriculum: room.curriculum, workMap: room.workMap });
  broadcast(room, { type: 'phase', phase: 'curriculum' });
}

export function agentJSON(room) { return toAgentJSON(room); }

// ---- practice (student, AI coaches on guide's behalf) ----
export function startPractice(room, studentId = 's') {
  room.phase = 'practice';
  room.practice[studentId] = { inv: teachInvoice(), caught: false, score: [] };
  broadcast(room, { type: 'phase', phase: 'practice' });
  return room.practice[studentId];
}
export async function practiceAttempt(room, { studentId = 's', cc, action }) {
  const p = room.practice[studentId] || startPractice(room, studentId);
  p.inv.cc = cc;
  let verdict = planner.evaluateTeachDecision(p.inv, { cc });
  if (!verdict.ok && !p.caught) {
    p.caught = true;
    verdict = await practiceFeedback(room, verdict);
    p.score.push({ label: verdict.scoreLabel, ok: false, note: verdict.scoreNote });
    broadcast(room, { type: 'practice_catch', studentId, question: verdict.question, guardrail: true });
    return { outcome: 'caught' };
  }
  p.score.push({
    label: p.caught ? 'Corrected after coaching' : verdict.scoreLabel,
    ok: true,
    note: p.caught ? 'Fixed the cost center to capex (0400) after the coach flagged it.' : verdict.scoreNote,
  });
  p.inv.action = action;
  broadcast(room, { type: 'practice_done', studentId, score: p.score });
  return { outcome: 'done', score: p.score };
}

// ---- background watcher: paces the AI's questions ----
let loop = false;
export function startWatcher() {
  if (loop) return; loop = true;
  setInterval(async () => {
    for (const room of rooms.values()) {
      if (!['capture'].includes(room.phase)) continue;
      if (planner.shouldSpeak(room, now(room))) {
        const cand = room.queued; room.queued = null;
        const phrased = await phraseGuideQuestion(room, cand).catch(() => cand);
        room.pending = phrased; room.askedKeys.add(cand.key);
        broadcast(room, { type: 'ask', question: phrased.q, guardrail: phrased.guardrail, stepKey: phrased.stepKey, invId: phrased.invId });
      }
    }
  }, 400);
}
