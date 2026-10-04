// Rooms: a Guide and one or more Students share one live session.
// Any action fans out to everyone over SSE (broadcast). The background watcher
// paces the AI's questions to the Guide (one at a time, only after a pause) and
// refreshes the Student's suggested questions. After the session it builds a
// shared curriculum the Student can practice against, with the AI coaching on
// the Guide's behalf.

import crypto from 'node:crypto';
import { simpleDemoInvoices, teachInventoryCases } from './scenario.js';
import * as planner from './planner.js';
import { buildWorkMap, toAgentJSON } from './workmap.js';
import { phraseGuideQuestion, studentSuggestions, idleGuideQuestion, buildCurriculum, practiceFeedback, summarizeAnswer, generateDebriefQuestions, answerStudentQuestion } from './reasoning.js';
import { translateTo, SUPPORTED_LANGS } from './translate.js';

const rooms = new Map(); // code -> room
const subs = new Map(); // code -> Set<{res, role, id}>

// Chat activity summaries are intentionally sparse. Vision can analyze much more
// often, but the transcript should receive at most one summary per minute.
const SUMMARY_MIN_MS = Math.max(60000, Number(process.env.ACTIVITY_SUMMARY_INTERVAL_MS) || 60000);
const SUGGESTION_REFRESH_MS = Math.max(3000, Number(process.env.SUGGESTION_REFRESH_MS) || 6000);
const IDLE_QUESTION_MS = Math.max(8000, Number(process.env.IDLE_QUESTION_MS) || 15000);
const IDLE_QUESTION_COOLDOWN_MS = Math.max(8000, Number(process.env.IDLE_QUESTION_COOLDOWN_MS) || 18000);
const QUESTION_REPEAT_MS = 60000;

function code4() {
  const s = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 5 }, () => s[Math.floor(Math.random() * s.length)]).join('');
}
function now(room) { return room.created ? Date.now() - room.created : 0; }

export function createRoom() {
  let code; do { code = code4(); } while (rooms.has(code));
  const room = {
    code, created: Date.now(), phase: 'capture',
    invoices: simpleDemoInvoices(), events: [], qa: [], chat: [],
    suggestions: [], workMap: [], curriculum: null,
    pending: null, queued: null, askedKeys: new Set(),
    lastActivity: 0, typing: false, speaking: false,
    debriefQ: null, debriefIdx: -1,
    practice: {}, practiceCompleted: new Set(), latestFrame: null, redact: false,
    screenSummary: '', lastVisionQuestion: null, lastActivitySummary: '', lastSummaryAt: -Infinity,
    questionsPaused: false, shareState: { sharing: false, paused: false },
    guideLanguage: 'en',
    lastStudentQuestionAt: 0, lastQuestionAt: 0, lastQuestionAttemptAt: 0,
    ackUntil: 0,
    lastSuggestionsAt: -Infinity, suggestionsBusy: false, idleQuestionBusy: false,
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
    controls: { questionsPaused: room.questionsPaused, shareState: room.shareState },
    guideLanguage: room.guideLanguage,
    latestFrame: room.latestFrame,
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
function pushEvent(room, text, meta = {}) {
  const ev = { t: now(room), text, ...meta };
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
    const label = inv.category === 'inventory'
      ? { approve: 'put into stock', hold: 'quarantined', escalate: 'reorder queued' }[action]
      : { approve: 'approved & posted', hold: 'held', escalate: 'sent for 2nd approval' }[action];
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

function recordActivitySummary(room, text) {
  const summary = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 260);
  if (!summary) return;
  const at = now(room);
  const same = summary.toLowerCase() === String(room.lastActivitySummary || '').toLowerCase();
  if (same || at - room.lastSummaryAt < SUMMARY_MIN_MS) return;
  room.lastActivitySummary = summary; room.lastSummaryAt = at;
  const msg = { from: 'activity', text: summary, t: at, source: 'vision' };
  room.chat.push(msg);
  broadcast(room, { type: 'chat', msg });
}

// Apply one Claude screen analysis without assuming any particular application.
// Vision-originated questions are already phrased by Claude, so they bypass a
// second LLM call in the watcher.
export function applyVisionAnalysis(room, analysis = {}) {
  if (analysis.summary) room.screenSummary = analysis.summary;
  if (analysis.activitySummary) recordActivitySummary(room, analysis.activitySummary);
  for (const ev of analysis.events || []) {
    const text = String(ev.text || '').trim();
    if (!text) continue;
    const prev = room.events[room.events.length - 1];
    if (prev && prev.text === text && now(room) - prev.t < 12000) continue;
    pushEvent(room, text, { source: 'vision', kind: ev.kind || 'other', importance: ev.importance || 'medium' });
  }
  if ((analysis.events || []).length) reportActivity(room, { typing: false });

  if (Array.isArray(analysis.studentQuestions) && analysis.studentQuestions.length) {
    room.suggestions = analysis.studentQuestions.slice(0, 3).map((q) => ({ q }));
    room.lastSuggestionsAt = now(room);
    broadcast(room, { type: 'suggestions', suggestions: room.suggestions }, 'student');
  }

  const q = analysis.question;
  if (q && q.q) {
    const key = 'vision:' + (q.key || q.q.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80));
    room.lastVisionQuestion = {
      key, q: q.q, guardrail: !!q.guardrail, stepKey: 'screen_observation',
      invId: null, source: 'vision', phrased: true, at: now(room),
    };
    const urgentVisibleMoment = !!q.guardrail || (analysis.events || []).some((e) =>
      e && (e.importance === 'high' || ['decision', 'warning', 'submission'].includes(e.kind)));
    if (urgentVisibleMoment && !room.pending && !room.queued && !room.questionsPaused && !room.askedKeys.has(key)) {
      room.queued = { ...room.lastVisionQuestion };
    }
  }
}

export function setQuestionsPaused(room, paused) {
  room.questionsPaused = !!paused;
  if (room.questionsPaused) room.queued = null;
  else if (!room.pending && !room.queued && room.lastVisionQuestion && now(room) - room.lastVisionQuestion.at < 30000 && !room.askedKeys.has(room.lastVisionQuestion.key)) {
    room.queued = { ...room.lastVisionQuestion };
    room.lastActivity = now(room); // resume, then wait for a natural pause before speaking
  }
  broadcast(room, { type: 'question_mode', paused: room.questionsPaused });
}

export function setShareState(room, state = {}) {
  room.shareState = {
    sharing: typeof state.sharing === 'boolean' ? state.sharing : room.shareState.sharing,
    paused: typeof state.paused === 'boolean' ? state.paused : room.shareState.paused,
  };
  if ((!room.shareState.sharing || room.shareState.paused) && ['vision', 'idle'].includes(room.queued?.source)) room.queued = null;
  broadcast(room, { type: 'share_state', ...room.shareState });
}

function queueGuideQuestion(room, trigger, inv) {
  if (room.pending || room.queued) return;
  const cand = planner.questionFor(trigger, inv);
  if (!cand || room.askedKeys.has(cand.key)) return;
  room.queued = cand; // released by the watcher after a pause
}

async function refreshSuggestions(room) {
  if (room.suggestionsBusy) return;
  room.suggestionsBusy = true;
  room.lastSuggestionsAt = now(room);
  try {
    room.suggestions = await studentSuggestions(room);
    broadcast(room, { type: 'suggestions', suggestions: room.suggestions }, 'student');
  } catch { /* keep previous */ }
  finally { room.suggestionsBusy = false; }
}

// ---- chat: either side can speak/type ----
export async function postChat(room, { from, text, to }) {
  if (from === 'student') {
    const msg = { from, text, t: now(room) };
    room.chat.push(msg);
    broadcast(room, { type: 'chat', msg });
    // a student question for the guide; also captured as a clarification
    room.lastStudentQuestionAt = now(room);
    room.qa.push({ q: `(student) ${text}`, a: null, invId: null, stepKey: 'student_q', guardrail: false, t: now(room) });
    refreshSuggestions(room);
    // During capture the Guide owns the explanation. Mentaur only speaks on
    // the Guide's behalf after the Work Map has been completed for practice.
    if (room.phase === 'practice') {
      let answer;
      try {
        answer = await answerStudentQuestion(room, text);
      } catch (err) {
        console.warn(`[reasoning] student answer unavailable: ${err.message}`);
        answer = 'Use the Work Map evidence first, then ask a human if the condition or count is unclear.';
      }
      broadcast(room, { type: 'chat', msg: { from: 'agent', text: answer, t: now(room) } });
    }
    return;
  }
  if (from === 'guide') {
    // The Guide explains in their chosen language; everything downstream (qa,
    // curriculum, the Student's transcript) runs in English, so translate once
    // here. The Guide's own transcript still shows exactly what they typed.
    const lang = room.guideLanguage || 'en';
    let textEn = text;
    if (lang !== 'en') {
      try { textEn = await translateTo(text, 'en'); }
      catch (err) { console.warn(`[translate] guide->en unavailable: ${err.message}`); }
    }
    const msg = { from, text: textEn, t: now(room) };
    if (lang !== 'en') msg.original = text;
    room.chat.push(msg);
    broadcast(room, { type: 'chat', msg });

    // guide speaking: if answering the AI's pending question, capture it
    if (room.pending) {
      const q = room.pending;
      room.qa.push({ q: q.q, a: textEn, invId: q.invId, stepKey: q.stepKey, guardrail: q.guardrail, t: now(room) });
      room.pending = null;
      room.ackUntil = now(room) + 3500;
      let idea;
      try {
        idea = await summarizeAnswer(room, q.q, textEn);
      } catch (err) {
        console.warn(`[reasoning] answer summary unavailable: ${err.message}`);
        idea = `Got it — thanks for explaining.`;
      }
      if (lang !== 'en') {
        try { idea = await translateTo(idea, lang); }
        catch (err) { console.warn(`[translate] ack unavailable: ${err.message}`); }
      }
      broadcast(room, {
        type: 'ack', guardrail: q.guardrail, coverage: planner.coverage(room.invoices, room.qa),
        spoken: idea,
      });
      if (room.phase === 'debrief') nextDebrief(room);
      else maybeOfferDebrief(room);
    } else {
      // guide answering a student's open question → attach to the latest student_q
      const open = [...room.qa].reverse().find((x) => x.stepKey === 'student_q' && x.a === null);
      if (open) open.a = textEn;
    }
    refreshSuggestions(room);
  }
}

export function setRedact(room, on) { room.redact = on; broadcast(room, { type: 'redact', on }); }
// The Guide's chosen explanation language. When set to 'ja'/'vi', the Guide's
// answers are translated to English before they're used for qa/curriculum and
// relayed to the Student; Mentaur's questions to the Guide are translated the
// other way so the Guide hears/reads them in their own language.
export function setGuideLanguage(room, lang) {
  room.guideLanguage = SUPPORTED_LANGS.includes(lang) ? lang : 'en';
  broadcast(room, { type: 'language', lang: room.guideLanguage });
}
export function setSpeaking(room, on) { room.speaking = on; }
export function setOffRecord(room, on) { room.offRecord = on; }

// ---- debrief + teach-back (AI with the guide) ----
function maybeOfferDebrief(room) {
  if (room.invoices.every((i) => i.action) && room.phase === 'capture' &&
      !room.pending && !room.queued && !room._debriefOffered) {
    room._debriefOffered = true;
    broadcast(room, { type: 'debrief_ready' });
  }
}
export async function startDebrief(room) {
  room.phase = 'debrief';
  room.debriefQ = await generateDebriefQuestions(room, planner.debriefQuestions(room.invoices, room.qa));
  room.debriefIdx = -1;
  broadcast(room, { type: 'phase', phase: 'debrief' });
  nextDebrief(room);
}
async function nextDebrief(room) {
  room.debriefIdx++;
  if (room.debriefIdx >= room.debriefQ.length) {
    room.phase = 'teachback';
    broadcast(room, { type: 'teachback', steps: buildWorkMap(room) });
    return;
  }
  const q = room.debriefQ[room.debriefIdx];
  const lang = room.guideLanguage || 'en';
  let questionLocal = q.q;
  if (lang !== 'en') {
    try { questionLocal = await translateTo(q.q, lang); }
    catch (err) { console.warn(`[translate] debrief question unavailable: ${err.message}`); }
  }
  room.pending = { ...q, questionLocal, debrief: true, askedAt: now(room), repeatCount: 0 };
  broadcast(room, { type: 'ask', question: q.q, questionLocal, guardrail: q.guardrail, progress: { i: room.debriefIdx + 1, n: room.debriefQ.length } });
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
  const caseIndex = room.practice[studentId]?.caseIndex == null ? 0 : (room.practice[studentId].caseIndex + 1) % teachInventoryCases().length;
  room.practice[studentId] = { inv: teachInventoryCases()[caseIndex], caseIndex, caught: false, score: [] };
  broadcast(room, { type: 'phase', phase: 'practice' });
  return room.practice[studentId];
}
export async function practiceAttempt(room, { studentId = 's', cc, action }) {
  const p = room.practice[studentId] || startPractice(room, studentId);
  p.inv.cc = cc;
  let verdict = planner.evaluateTeachDecision(p.inv, { cc });
  verdict = { ...verdict, inv: p.inv };
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
  const totalCases = teachInventoryCases().length;
  room.practiceCompleted.add(p.caseIndex);
  const completedCases = room.practiceCompleted.size;
  const allComplete = completedCases >= totalCases;
  broadcast(room, { type: 'practice_done', studentId, score: p.score, caseIndex: p.caseIndex, completedCases, totalCases, allComplete });
  return { outcome: 'done', score: p.score, caseIndex: p.caseIndex, completedCases, totalCases, allComplete };
}

// ---- background watcher: paces the AI's questions + live learner prompts ----
function shouldRefreshSuggestions(room, at) {
  return room.shareState.sharing && !room.shareState.paused && room.students > 0 &&
    !room.suggestionsBusy && at - room.lastSuggestionsAt >= SUGGESTION_REFRESH_MS &&
    !!(room.screenSummary || room.events.length);
}

export function shouldQueueIdleQuestion(room, at) {
  if (!room.shareState.sharing || room.shareState.paused || room.questionsPaused) return false;
  if (room.pending || room.queued || room.speaking || room.typing || room.idleQuestionBusy) return false;
  // A live shared frame is enough to keep the occasional-question cadence alive.
  // This matters in mock/keyless mode and during transient vision failures, where
  // arbitrary tabs may have a frame but no Claude summary/events yet.
  if (!room.latestFrame && !room.screenSummary && !room.events.length) return false;
  const lastLearnerQuestion = room.lastStudentQuestionAt || 0;
  const lastAnyQuestion = room.lastQuestionAt || 0;
  if (at - lastLearnerQuestion < IDLE_QUESTION_MS) return false;
  if (at - lastAnyQuestion < IDLE_QUESTION_COOLDOWN_MS) return false;
  if (at - room.lastQuestionAttemptAt < IDLE_QUESTION_MS) return false;
  return true;
}

async function queueIdleQuestion(room, at) {
  room.idleQuestionBusy = true; room.lastQuestionAttemptAt = at;
  try {
    let cand = room.lastVisionQuestion && at - room.lastVisionQuestion.at <= IDLE_QUESTION_MS
      ? { ...room.lastVisionQuestion, source: 'idle' }
      : null;
    if (!cand || room.askedKeys.has(cand.key)) cand = await idleGuideQuestion(room);
    if (!cand || room.pending || room.queued || room.questionsPaused || room.askedKeys.has(cand.key)) return;
    room.queued = { ...cand, source: 'idle', queuedAt: now(room) };
  } catch { /* try again after the next idle interval */ }
  finally { room.idleQuestionBusy = false; }
}

let loop = false;
export function startWatcher() {
  if (loop) return; loop = true;
  setInterval(async () => {
    for (const room of rooms.values()) {
      if (!['capture'].includes(room.phase)) continue;
      const at = now(room);

      if (shouldRefreshSuggestions(room, at)) refreshSuggestions(room);
      if (shouldQueueIdleQuestion(room, at)) queueIdleQuestion(room, at);

      if (at >= room.ackUntil && planner.shouldSpeak(room, at)) {
        const cand = room.queued; room.queued = null;
        const phrased = await phraseGuideQuestion(room, cand).catch(() => cand);
        if (!phrased || !phrased.q) continue;
        const lang = room.guideLanguage || 'en';
        let questionLocal = phrased.q;
        if (lang !== 'en') {
          try { questionLocal = await translateTo(phrased.q, lang); }
          catch (err) { console.warn(`[translate] question unavailable: ${err.message}`); }
        }
        room.pending = { ...phrased, questionLocal, askedAt: now(room), repeatCount: 0 };
        room.askedKeys.add(cand.key); room.lastQuestionAt = now(room);
        broadcast(room, { type: 'ask', question: phrased.q, questionLocal, guardrail: phrased.guardrail, stepKey: phrased.stepKey, invId: phrased.invId });
      }
      if (room.pending && !room.speaking && at - (room.pending.askedAt || 0) >= QUESTION_REPEAT_MS) {
        room.pending.askedAt = at;
        room.pending.repeatCount = (room.pending.repeatCount || 0) + 1;
        broadcast(room, {
          type: 'ask', question: room.pending.q, questionLocal: room.pending.questionLocal, guardrail: room.pending.guardrail,
          stepKey: room.pending.stepKey, invId: room.pending.invId,
          repeat: true, repeatCount: room.pending.repeatCount,
        });
      }
    }
  }, 400);
}

export const liveCadence = { SUMMARY_MIN_MS, SUGGESTION_REFRESH_MS, IDLE_QUESTION_MS, IDLE_QUESTION_COOLDOWN_MS, QUESTION_REPEAT_MS };
