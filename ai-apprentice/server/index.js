// The AI Apprentice — server.
// Pure Node built-ins. Serves the web UI, a room-based JSON API, and a per-room
// Server-Sent-Events broadcast that keeps the Guide and Student pages in sync.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import * as R from './lib/room.js';
import { redactDeep } from './lib/redact.js';
import { captureInvoices, teachInvoice, COST_CENTERS } from './lib/scenario.js';
import { analyzeFrame, visionMode } from './lib/vision.js';
import { getSignedUrl, tts, voiceMode } from './lib/voice.js';
import { reasoningMode, summarizeScrape } from './lib/reasoning.js';
import { translateMode, SUPPORTED_LANGS } from './lib/translate.js';
import { scrapeUrl, scrapeMode } from './lib/scrape.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, '../web');
const PORT = process.env.PORT || 8787;
const VISION_INTERVAL_MS = Math.max(2500, Number(process.env.VISION_INTERVAL_MS) || 4000);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

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

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const p = u.pathname;
  try {
    if (p.startsWith('/api/')) return await api(req, res, u);
    let file = p === '/' ? '/index.html' : p;
    const full = path.join(WEB_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(WEB_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    fs.createReadStream(full).pipe(res);
  } catch (e) { console.error(e); send(res, 500, { error: e.message }); }
});

async function api(req, res, u) {
  const p = u.pathname;
  const parts = p.split('/').filter(Boolean); // ['api','room',code,action]

  if (p === '/api/config' && req.method === 'GET') {
    return send(res, 200, { visionMode, voiceMode, reasoningMode, translateMode, scrapeMode, supportedLangs: SUPPORTED_LANGS, visionIntervalMs: VISION_INTERVAL_MS, liveCadence: R.liveCadence, costCenters: COST_CENTERS });
  }
  if (p === '/api/scenario' && req.method === 'GET') {
    return send(res, 200, { capture: captureInvoices(), teach: teachInvoice(), costCenters: COST_CENTERS });
  }
  if (p === '/api/room' && req.method === 'POST') {
    return send(res, 200, { code: R.createRoom() });
  }
  if (p === '/api/voice/signed-url' && req.method === 'GET') {
    try { return send(res, 200, { url: await getSignedUrl() }); } catch (e) { return send(res, 200, { url: null, error: e.message }); }
  }
  if (p === '/api/voice/tts' && req.method === 'POST') {
    const body = await readBody(req); const buf = await tts(body.text || '', body.lang);
    if (!buf) return send(res, 200, { mock: true });
    res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(buf);
  }
  if (p === '/api/scrape' && req.method === 'POST') {
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
  if (p === '/api/vision' && req.method === 'POST') {
    const body = await readBody(req); const room = R.getRoom(body.code);
    const out = await analyzeFrame(body.next, room?.screenSummary || '');
    if (room) R.applyVisionAnalysis(room, out);
    return send(res, 200, out);
  }

  if (parts[1] === 'room' && parts[2]) {
    const room = R.getRoom(parts[2]);
    if (!room) return send(res, 404, { error: 'no such room' });
    const action = parts[3];
    if (!action && req.method === 'GET') return send(res, 200, R.roomView(room));

    if (action === 'stream' && req.method === 'GET') {
      const role = u.searchParams.get('role') === 'guide' ? 'guide' : 'student';
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', phase: room.phase, you: role })}\n\n`);
      R.subscribe(room.code, role, res);
      const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch { clearInterval(ka); } }, 15000);
      req.on('close', () => clearInterval(ka));
      return;
    }

    const body = req.method === 'POST' ? await readBody(req) : {};
    switch (action) {
      case 'activity': R.reportActivity(room, body); return send(res, 200, { ok: true });
      case 'change': R.applyChange(room, body); return send(res, 200, R.roomView(room));
      case 'chat': await R.postChat(room, body); return send(res, 200, { ok: true });
      case 'frame': if (body.frame) R.pushFrame(room, body.frame); return send(res, 200, { ok: true });
      case 'redact': R.setRedact(room, !!body.on); return send(res, 200, { ok: true });
      case 'language': R.setGuideLanguage(room, body.lang); return send(res, 200, { ok: true, lang: room.guideLanguage });
      case 'speaking': R.setSpeaking(room, !!body.on); return send(res, 200, { ok: true });
      case 'question-mode': R.setQuestionsPaused(room, !!body.paused); return send(res, 200, { ok: true, paused: room.questionsPaused });
      case 'share-state': R.setShareState(room, body); return send(res, 200, { ok: true, shareState: room.shareState });
      case 'offrecord': R.setOffRecord(room, !!body.on); return send(res, 200, { ok: true });
      case 'debrief': await R.startDebrief(room); return send(res, 200, { ok: true });
      case 'confirm': await R.confirmTeachback(room); return send(res, 200, { ok: true });
      case 'practice': return send(res, 200, R.startPractice(room, body.studentId));
      case 'practice-attempt': return send(res, 200, await R.practiceAttempt(room, body));
      case 'curriculum': return send(res, 200, { curriculum: room.curriculum, workMap: room.workMap });
      case 'export': {
        const json = JSON.stringify(redactDeep(R.agentJSON(room), room.redact), null, 2);
        return send(res, 200, json, { 'content-disposition': 'attachment; filename="work-map.json"' });
      }
    }
  }
  send(res, 404, { error: 'unknown endpoint' });
}

R.startWatcher();
server.listen(PORT, () => {
  console.log(`\n  Mentaur · AI Apprentice`);
  console.log(`  ─────────────────`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  vision: ${visionMode}   voice: ${voiceMode}   reasoning: ${reasoningMode}`);
  console.log(`  ${visionMode === 'mock' && voiceMode === 'local' ? 'KEYLESS mode — Claude mock + local browser TTS.\n' : 'Live provider(s) configured.\n'}`);
});
