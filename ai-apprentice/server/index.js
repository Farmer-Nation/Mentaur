// Mentaur server: authenticated teacher/learner rooms + persistent Supabase knowledge.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as R from './lib/room.js';
import { redactDeep } from './lib/redact.js';
import { captureInvoices, teachInvoice, COST_CENTERS } from './lib/scenario.js';
import { analyzeFrame, visionMode } from './lib/vision.js';
import { getSignedUrl, tts, voiceMode } from './lib/voice.js';
import { reasoningMode, summarizeScrape, answerKnowledgeBaseQuestion } from './lib/reasoning.js';
import { translateMode, SUPPORTED_LANGS } from './lib/translate.js';
import { scrapeUrl, scrapeMode } from './lib/scrape.js';
import {
  supabaseMode, hasServiceRole, signUp, signIn, signOut, getAuthContext,
  applySession, clearSessionCookies, parseCookies,
} from './lib/supabase.js';
import { roleForProfile, canAccessRoom, canPerformRoomAction } from './lib/authz.js';
import {
  createLearningSession, addLearnerToSession, persistRoomKnowledge, getTeacherLibrary,
  searchLearnerKnowledge, cacheKey, getCachedAnswer, putCachedAnswer,
} from './lib/knowledge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');
const PORT = process.env.PORT || 8787;
const VISION_INTERVAL_MS = Math.max(2500, Number(process.env.VISION_INTERVAL_MS) || 4000);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm' };

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 25e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
function normalizeSession(data) { return data?.session?.access_token ? data.session : data?.access_token ? data : null; }
function publicUser(ctx) {
  return { id: ctx.user.id, email: ctx.user.email || '', fullName: ctx.profile.full_name || '', role: ctx.profile.role };
}
async function requireAuth(req, res, role) {
  const ctx = await getAuthContext(req, res).catch(() => null);
  if (!ctx) { send(res, 401, { error: 'Authentication required.' }); return null; }
  if (role && ctx.profile.role !== role) { send(res, 403, { error: `This action requires a ${role} account.` }); return null; }
  return ctx;
}
async function maybePersist(room, options) {
  try { await persistRoomKnowledge(room, options); }
  catch (e) { console.warn('[knowledge] persistence skipped:', e.message); }
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, u);
    if (p.startsWith('/vendor/tesseract/')) {
      const relative = p.slice('/vendor/tesseract/'.length);
      const roots = [
        path.resolve(__dirname, '../node_modules/tesseract.js/dist'),
        path.resolve(__dirname, '../node_modules/tesseract.js-core'),
      ];
      const full = path.resolve(roots[0], relative);
      const coreFull = path.resolve(roots[1], relative);
      const target = fs.existsSync(full) ? full : coreFull;
      if (!target.startsWith(roots[0]) && !target.startsWith(roots[1])) { res.writeHead(404); return res.end('Not found'); }
      if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
      res.writeHead(200, { 'content-type': MIME[path.extname(target)] || 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
      return fs.createReadStream(target).pipe(res);
    }
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(WEB_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, e.status && e.status < 600 ? e.status : 500, { error: e.message }); }
});

async function api(req, res, u) {
  const p = u.pathname;
  const parts = p.split('/').filter(Boolean); // ['api','room',code,action]

  if (p === '/api/config' && req.method === 'GET') {
    return send(res, 200, {
      visionMode, voiceMode, reasoningMode, translateMode, scrapeMode, supabaseMode,
      knowledgeMode: supabaseMode === 'supabase' && hasServiceRole ? 'supabase-fts' : 'off',
      supportedLangs: SUPPORTED_LANGS, visionIntervalMs: VISION_INTERVAL_MS,
      liveCadence: R.liveCadence, costCenters: COST_CENTERS,
    });
  }

  // ---- Authentication ----
  if (p === '/api/auth/signup' && req.method === 'POST') {
    if (supabaseMode === 'off') return send(res, 503, { error: 'Supabase auth is not configured on this server.' });
    const body = await readBody(req);
    const email = String(body.email || '').trim().toLowerCase();
    const password = String(body.password || '');
    const fullName = String(body.fullName || '').trim().slice(0, 120);
    const role = body.role === 'teacher' ? 'teacher' : body.role === 'learner' ? 'learner' : '';
    if (!email || password.length < 8 || !role) return send(res, 400, { error: 'Use a valid email, an 8+ character password, and choose Teacher or Learner.' });
    const data = await signUp({ email, password, fullName, role });
    const session = normalizeSession(data);
    if (!session) return send(res, 500, { error: 'Account created, but automatic sign-in failed.' });
    applySession(res, session);
    return send(res, 200, { ok: true, email });
  }
  if (p === '/api/auth/login' && req.method === 'POST') {
    if (supabaseMode === 'off') return send(res, 503, { error: 'Supabase auth is not configured on this server.' });
    const body = await readBody(req);
    const data = await signIn({ email: String(body.email || '').trim().toLowerCase(), password: String(body.password || '') });
    const session = normalizeSession(data);
    if (!session) return send(res, 401, { error: 'Sign in failed.' });
    applySession(res, session);
    const ctx = await getAuthContext(reqWithCookie(req, session), res).catch(() => null);
    return send(res, 200, { ok: true, user: ctx ? publicUser(ctx) : { email: data.user?.email || '' } });
  }
  if (p === '/api/auth/me' && req.method === 'GET') {
    const ctx = await getAuthContext(req, res).catch(() => null);
    return send(res, 200, ctx ? { authenticated: true, user: publicUser(ctx) } : { authenticated: false });
  }
  if (p === '/api/auth/logout' && req.method === 'POST') {
    const cookies = parseCookies(req);
    await signOut(cookies.mentaur_access).catch(() => {});
    clearSessionCookies(res);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/scenario' && req.method === 'GET') {
    return send(res, 200, { capture: captureInvoices(), teach: teachInvoice(), costCenters: COST_CENTERS });
  }

  // ---- Knowledge base ----
  if (p === '/api/knowledge/teacher' && req.method === 'GET') {
    const ctx = await requireAuth(req, res, 'teacher'); if (!ctx) return;
    return send(res, 200, { sessions: await getTeacherLibrary(ctx.user.id) });
  }
  if (p === '/api/knowledge/ask' && req.method === 'POST') {
    const ctx = await requireAuth(req, res, 'learner'); if (!ctx) return;
    const body = await readBody(req);
    const question = String(body.question || '').replace(/\s+/g, ' ').trim().slice(0, 800);
    if (!question) return send(res, 400, { error: 'Type or speak a question first.' });
    const chunks = await searchLearnerKnowledge(ctx.user.id, question, 6);
    const key = cacheKey(ctx.user.id, question, chunks);
    const cached = getCachedAnswer(key);
    if (cached) return send(res, 200, { answer: cached.answer, grounded: cached.grounded, sources: cached.sources, cached: true });
    const result = await answerKnowledgeBaseQuestion(question, chunks);
    const sources = chunks.slice(0, 6).map((c) => ({
      teacher: c.teacher_name, session: c.session_title, title: c.title,
      startedAt: c.session_started_at, kind: c.kind,
    }));
    const answer = { ...result, sources };
    putCachedAnswer(key, answer);
    return send(res, 200, answer);
  }

  // ---- Voice / scrape ----
  if (p === '/api/voice/signed-url' && req.method === 'GET') {
    const ctx = await requireAuth(req, res); if (!ctx) return;
    try { return send(res, 200, { url: await getSignedUrl() }); } catch (e) { return send(res, 200, { url: null, error: e.message }); }
  }
  if (p === '/api/voice/tts' && req.method === 'POST') {
    const ctx = await requireAuth(req, res); if (!ctx) return;
    const body = await readBody(req); const buf = await tts(body.text || '', body.lang);
    if (!buf) return send(res, 200, { mock: true });
    res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(buf);
  }
  if (p === '/api/scrape' && req.method === 'POST') {
    const ctx = await requireAuth(req, res); if (!ctx) return;
    const body = await readBody(req);
    const url = String(body.url || '').trim();
    if (!url) return send(res, 200, { error: 'Paste a URL to scrape.' });
    if (scrapeMode === 'off') return send(res, 200, { error: 'Bright Data is not configured on this server (BRIGHTDATA_WS_ENDPOINT missing).' });
    try {
      const { url: finalUrl, title, text } = await scrapeUrl(url);
      const summary = await summarizeScrape(finalUrl, title, text);
      return send(res, 200, { url: finalUrl, title, summary });
    } catch (e) {
      console.warn('[scrape] failed:', e.message);
      return send(res, 200, { error: e.message || 'Scrape failed.' });
    }
  }

  // ---- Rooms ----
  if (p === '/api/room' && req.method === 'POST') {
    const ctx = await requireAuth(req, res, 'teacher'); if (!ctx) return;
    const code = R.createRoom({ teacherId: ctx.user.id, teacherName: ctx.profile.full_name || ctx.user.email || 'Teacher' });
    const room = R.getRoom(code);
    if (supabaseMode === 'supabase' && hasServiceRole) await createLearningSession(room);
    return send(res, 200, { code });
  }

  if (p === '/api/vision' && req.method === 'POST') {
    const ctx = await requireAuth(req, res, 'teacher'); if (!ctx) return;
    const body = await readBody(req); const room = R.getRoom(body.code);
    if (!room || !canAccessRoom(ctx, room)) return send(res, 403, { error: 'You do not own this room.' });
    const out = await analyzeFrame(body.next, room?.screenSummary || '');
    if (room) { R.applyVisionAnalysis(room, out); await maybePersist(room); }
    return send(res, 200, out);
  }

  if (parts[1] === 'room' && parts[2]) {
    const room = R.getRoom(parts[2].toUpperCase());
    if (!room) return send(res, 404, { error: 'no such room' });
    const action = parts[3];
    const ctx = await requireAuth(req, res); if (!ctx) return;

    if (action === 'join' && req.method === 'POST') {
      if (ctx.profile.role !== 'learner') return send(res, 403, { error: 'Only learner accounts can join teacher sessions.' });
      R.addLearner(room, ctx.user.id);
      await addLearnerToSession(room, ctx.user.id);
      return send(res, 200, { ok: true, code: room.code });
    }

    if (!canAccessRoom(ctx, room)) return send(res, 403, { error: 'You do not have access to this room.' });
    const you = roleForProfile(ctx.profile);

    if (!action && req.method === 'GET') return send(res, 200, { ...R.roomView(room), you, accountRole: ctx.profile.role });

    if (action === 'stream' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', phase: room.phase, you })}\n\n`);
      R.subscribe(room.code, you, res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { clearInterval(ka); } }, 15000);
      req.on('close', () => clearInterval(ka));
      return;
    }

    if (!canPerformRoomAction(ctx, room, action)) return send(res, 403, { error: 'Your account type cannot perform this room action.' });
    const body = req.method === 'POST' ? await readBody(req) : {};
    switch (action) {
      case 'activity': R.reportActivity(room, body); return send(res, 200, { ok: true });
      case 'change': R.applyChange(room, body); await maybePersist(room); return send(res, 200, R.roomView(room));
      case 'chat':
        await R.postChat(room, { ...body, from: you });
        await maybePersist(room);
        return send(res, 200, { ok: true });
      case 'frame': if (body.frame) R.pushFrame(room, body.frame, Number(body.seq)); return send(res, 200, { ok: true });
      case 'redact': R.setRedact(room, !!body.on); return send(res, 200, { ok: true });
      case 'language':
        if (you === 'student') {
          R.setStudentLanguage(room, body.lang);
          return send(res, 200, { ok: true, lang: room.studentLanguage });
        }
        R.setGuideLanguage(room, body.lang);
        return send(res, 200, { ok: true, lang: room.guideLanguage });
      case 'speaking': R.setSpeaking(room, !!body.on); return send(res, 200, { ok: true });
      case 'question-mode': R.setQuestionsPaused(room, !!body.paused); return send(res, 200, { ok: true, paused: room.questionsPaused });
      case 'share-state':
        R.setShareState(room, body);
        await maybePersist(room, { force: body.sharing === false });
        return send(res, 200, { ok: true, shareState: room.shareState });
      case 'offrecord': R.setOffRecord(room, !!body.on); return send(res, 200, { ok: true });
      case 'debrief': await R.startDebrief(room); await maybePersist(room, { force: true }); return send(res, 200, { ok: true });
      case 'confirm':
        await R.confirmTeachback(room);
        await maybePersist(room, { force: true, finalize: true });
        return send(res, 200, { ok: true });
      case 'practice': return send(res, 200, R.startPractice(room, ctx.user.id));
      case 'practice-attempt': return send(res, 200, await R.practiceAttempt(room, { ...body, studentId: ctx.user.id }));
      case 'curriculum': return send(res, 200, { curriculum: room.curriculum, workMap: room.workMap });
      case 'export': {
        const json = JSON.stringify(redactDeep(R.agentJSON(room), room.redact), null, 2);
        return send(res, 200, json, { 'content-disposition': 'attachment; filename="work-map.json"' });
      }
    }
  }
  send(res, 404, { error: 'unknown endpoint' });
}

// Helper used only immediately after login so /auth/me-style profile loading can
// validate the brand-new access token before the browser has stored the Set-Cookie response.
function reqWithCookie(req, session) {
  return { ...req, headers: { ...req.headers, cookie: `mentaur_access=${encodeURIComponent(session.access_token)}; mentaur_refresh=${encodeURIComponent(session.refresh_token)}` } };
}

R.startWatcher();
server.listen(PORT, () => {
  console.log(`\n  Mentaur · AI Apprentice`);
  console.log(`  ─────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  supabase: ${supabaseMode}${hasServiceRole ? ' + service role' : ''}`);
  console.log(`  vision: ${visionMode}   voice: ${voiceMode}   reasoning: ${reasoningMode}`);
  console.log(`  ${visionMode === 'mock' && voiceMode === 'local' ? 'KEYLESS AI mode — browser voice + mock Claude, with Supabase auth when configured.\n' : 'Live provider(s) configured.\n'}`);
});
