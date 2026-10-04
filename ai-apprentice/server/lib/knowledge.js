// Supabase-backed session archive + lightweight full-text retrieval.
// No embedding provider is required: Postgres FTS finds a small evidence set,
// then Claude answers from those chunks. This keeps recurring API spend low.

import crypto from 'node:crypto';
import { adminDb, hasServiceRole, supabaseMode } from './supabase.js';

const PERSIST_INTERVAL_MS = Math.max(30000, Number(process.env.KNOWLEDGE_PERSIST_INTERVAL_MS) || 60000);

function cleanText(value, max = 4000) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeRoomArchive(room) {
  return {
    code: room.code,
    phase: room.phase,
    createdAt: room.created,
    teacherId: room.teacherId,
    screenSummary: room.screenSummary || '',
    invoices: room.invoices || [],
    events: room.events || [],
    qa: room.qa || [],
    chat: room.chat || [],
    workMap: room.workMap || [],
    curriculum: room.curriculum || null,
    guideLanguage: room.guideLanguage || 'en',
    studentLanguage: room.studentLanguage || 'en',
    captureMode: room.captureMode || 'simulation',
    shareState: room.shareState || { sharing: false, paused: false },
    questionsPaused: !!room.questionsPaused,
  };
}

function batchLines(lines, maxChars = 2600) {
  const out = []; let current = '';
  for (const line of lines.map((x) => cleanText(x, 1800)).filter(Boolean)) {
    if (current && current.length + line.length + 1 > maxChars) { out.push(current); current = ''; }
    current += (current ? '\n' : '') + line;
  }
  if (current) out.push(current);
  return out;
}

export function buildKnowledgeChunks(room) {
  const chunks = [];
  const push = (kind, title, content, metadata = {}) => {
    content = cleanText(content, 6000); if (!content) return;
    chunks.push({ kind, title: cleanText(title, 180), content, metadata });
  };

  push('overview', 'Session overview', [
    room.screenSummary ? `Screen summary: ${room.screenSummary}` : '',
    `Capture mode: ${room.captureMode || 'simulation'}`,
    `Phase: ${room.phase || 'capture'}`,
  ].filter(Boolean).join('\n'));

  batchLines((room.events || []).map((e) => `${e.text}${e.kind ? ` [${e.kind}]` : ''}`)).forEach((content, i) =>
    push('events', `Observed work ${i + 1}`, content, { batch: i + 1 }));

  batchLines((room.invoices || []).map((item) => [
    item.id ? `Item ${item.id}` : 'Item', item.desc || item.description || '',
    item.condition ? `condition ${item.condition}` : '', item.note ? `note ${item.note}` : '',
    item.cc ? `decision ${item.cc}` : '', item.action ? `action ${item.action}` : '',
  ].filter(Boolean).join(' · '))).forEach((content, i) =>
    push('session_data', `Session data ${i + 1}`, content, { batch: i + 1 }));

  batchLines((room.chat || []).map((m) => `${m.from}: ${m.text}`)).forEach((content, i) =>
    push('transcript', `Conversation ${i + 1}`, content, { batch: i + 1 }));

  batchLines((room.qa || []).map((x) => `Question: ${x.q}\nAnswer: ${x.a || '(unanswered)'}`)).forEach((content, i) =>
    push('qa', `Teacher reasoning ${i + 1}`, content, { batch: i + 1 }));

  for (const [i, step] of (room.workMap || []).entries()) {
    push('work_map', step.title || `Work Map step ${i + 1}`, [
      step.decision ? `Decision: ${step.decision}` : '',
      step.reason ? `Reason: ${step.reason}` : '',
      step.guardrail ? `Guardrail: ${step.guardrail}` : '',
      step.evidence ? `Evidence: ${step.evidence}` : '',
    ].filter(Boolean).join('\n'), { step: i + 1 });
  }

  if (room.curriculum) {
    push('curriculum', room.curriculum.title || 'Session playbook', room.curriculum.summary || '');
    for (const lesson of room.curriculum.lessons || []) {
      push('curriculum', lesson.title || `Lesson ${lesson.n || ''}`, [
        lesson.did ? `Did: ${lesson.did}` : '', lesson.reason ? `Why: ${lesson.reason}` : '',
        lesson.guardrail ? `When to stop: ${lesson.guardrail}` : '', lesson.check ? `Check: ${lesson.check}` : '',
      ].filter(Boolean).join('\n'), { lesson: lesson.n || null });
    }
  }
  return chunks.slice(0, 80);
}

export async function createLearningSession(room) {
  if (supabaseMode === 'off' || !hasServiceRole || !room.teacherId) return null;
  const rows = await adminDb('learning_sessions', {
    method: 'POST',
    body: [{ room_code: room.code, teacher_id: room.teacherId, title: `Mentaur session ${room.code}`, status: 'active' }],
    prefer: 'return=representation',
  });
  const row = Array.isArray(rows) ? rows[0] : null;
  if (row?.id) room.sessionId = row.id;
  return row;
}

export async function addLearnerToSession(room, learnerId) {
  if (supabaseMode === 'off' || !hasServiceRole || !room.sessionId || !learnerId) return;
  await adminDb('session_participants?on_conflict=session_id,learner_id', {
    method: 'POST', body: [{ session_id: room.sessionId, learner_id: learnerId }],
    prefer: 'resolution=merge-duplicates,return=minimal',
  });
}

export async function persistRoomKnowledge(room, { force = false, finalize = false } = {}) {
  if (supabaseMode === 'off' || !hasServiceRole || !room.sessionId || !room.teacherId) return { skipped: true };
  const now = Date.now();
  if (!force && now - (room._lastKnowledgePersist || 0) < PERSIST_INTERVAL_MS) return { skipped: true };
  room._lastKnowledgePersist = now;

  const archive = safeRoomArchive(room);
  const summary = cleanText(room.curriculum?.summary || room.screenSummary || room.events?.at(-1)?.text || 'Captured teaching session', 1000);
  await adminDb('session_archives?on_conflict=session_id', {
    method: 'POST',
    body: [{ session_id: room.sessionId, teacher_id: room.teacherId, payload: archive, updated_at: new Date().toISOString() }],
    prefer: 'resolution=merge-duplicates,return=minimal',
  });

  await adminDb(`knowledge_chunks?session_id=eq.${encodeURIComponent(room.sessionId)}`, { method: 'DELETE' });
  const rows = buildKnowledgeChunks(room).map((c, i) => ({
    session_id: room.sessionId,
    teacher_id: room.teacherId,
    source_key: `${c.kind}:${i + 1}`,
    kind: c.kind,
    title: c.title,
    content: c.content,
    metadata: c.metadata,
  }));
  if (rows.length) await adminDb('knowledge_chunks', { method: 'POST', body: rows, prefer: 'return=minimal' });

  const update = { summary, status: finalize ? 'complete' : 'active', updated_at: new Date().toISOString() };
  if (finalize) update.ended_at = new Date().toISOString();
  await adminDb(`learning_sessions?id=eq.${encodeURIComponent(room.sessionId)}`, { method: 'PATCH', body: update, prefer: 'return=minimal' });
  return { skipped: false, chunks: rows.length };
}

export async function getTeacherLibrary(teacherId) {
  if (supabaseMode === 'off' || !hasServiceRole) return [];
  const rows = await adminDb(`learning_sessions?teacher_id=eq.${encodeURIComponent(teacherId)}&select=id,room_code,title,summary,status,started_at,ended_at,updated_at&order=started_at.desc&limit=50`);
  return Array.isArray(rows) ? rows : [];
}

export async function searchLearnerKnowledge(learnerId, query, limit = 6) {
  if (supabaseMode === 'off' || !hasServiceRole) return [];
  const body = { p_learner_id: learnerId, p_query: cleanText(query, 500), p_limit: Math.max(1, Math.min(Number(limit) || 6, 8)) };
  const rows = await adminDb('rpc/search_learner_knowledge', { method: 'POST', body });
  return Array.isArray(rows) ? rows : [];
}

const cache = new Map();
export function cacheKey(learnerId, question, chunks) {
  const context = chunks.map((c) => `${c.id}:${c.updated_at || ''}`).join('|');
  return crypto.createHash('sha256').update(`${learnerId}|${cleanText(question, 800).toLowerCase()}|${context}`).digest('hex');
}
export function getCachedAnswer(key) {
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > 15 * 60 * 1000) { if (hit) cache.delete(key); return null; }
  return hit.answer;
}
export function putCachedAnswer(key, answer) {
  cache.set(key, { at: Date.now(), answer });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
}
