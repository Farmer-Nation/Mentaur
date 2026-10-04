// Mentaur — AI Apprentice room client (role-aware).
// The same file renders the Guide view and the Student view; the brain and all
// sync run on the server. Both roles can answer/ask by voice or text.

const $ = (s) => document.querySelector(s);
const el = (t, c, html) => { const e = document.createElement(t); if (c) e.className = c; if (html != null) e.innerHTML = html; return e; };
const api = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}).then((r) => r.json());

const params = new URLSearchParams(location.search);
const CODE = (params.get('code') || '').toUpperCase();
const ROLE = params.get('role') === 'guide' ? 'guide' : 'student';
const isGuide = ROLE === 'guide';

const S = {
  started: Date.now(), phase: 'capture', invoices: [], selected: null,
  costCenters: [], config: null, pending: null, redact: false, offRecord: false,
  speaking: false, micOn: false, recog: null, recogActive: false, micEnding: false,
  micBlocked: false, micDraft: '', voiceAnswerSubmitted: false,
  curriculum: null, workMap: [], guideLanguage: 'en', studentLanguage: 'en',
  teach: null, practiceStarted: false, shareStream: null, sharePaused: false, questionsPaused: false, sharing: false,
  redactionBusy: false, lastRedactionAt: 0,
  frameSeq: 0, lastFrameSeq: 0, suggestionsHidden: false, relayInFlight: false, pendingRelay: null,
  lastVisualFingerprint: null, visionDirty: false, lastVisionSentAt: 0,
  activeAudio: null, speechToken: 0,
};

/* ---------- clock ---------- */
setInterval(() => { $('#sessionClock').textContent = fmt(Date.now() - S.started); }, 500);
function fmt(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

/* ---------- voice ---------- */
const BCP47 = { en: 'en-US', ja: 'ja-JP', vi: 'vi-VN' };
function localSpeak(text, lang) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return setTimeout(resolve, 500 + text.length * 16);
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g, ''));
      u.lang = BCP47[lang] || 'en-US';
      u.rate = 1.02; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u);
    } catch { resolve(); }
  });
}
$('#suggestionsClose').onclick = () => { S.suggestionsHidden = true; $('#suggestions').style.display = 'none'; };
async function speak(text, lang) {
  if (!$('#ttsToggle').checked) return;
  stopSpeech({ announce: false });
  const token = ++S.speechToken;
  const voiceLang = lang || (isGuide ? S.guideLanguage : 'en');
  if (isGuide) { await api(`/api/room/${CODE}/speaking`, { on: true }); S.speaking = true; }
  setOrb('speaking'); setStatus('Speaking…');
  try {
    // Prefer ElevenLabs whenever configured. Wait for playback to actually finish
    // before returning so the microphone never starts underneath Mentaur's voice.
    if (S.config && S.config.voiceMode.startsWith('elevenlabs')) {
      try {
        const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, lang: voiceLang }) });
        if (token !== S.speechToken) return;
        if (r.ok && r.headers.get('content-type')?.includes('audio')) {
          const url = URL.createObjectURL(await r.blob());
          if (token !== S.speechToken) { URL.revokeObjectURL(url); return; }
          const a = new Audio(url);
          const played = await new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(ok); };
            a.onended = () => finish(true);
            a.onerror = () => finish(false);
            S.activeAudio = { audio: a, finish };
            a.play().catch(() => finish(false));
          });
          if (S.activeAudio?.audio === a) S.activeAudio = null;
          if (played) return;
        }
      } catch { /* use local TTS below */ }
    }
    if (token !== S.speechToken) return;
    await localSpeak(text, voiceLang);
  } finally {
    if (token === S.speechToken) {
      if (isGuide) { await api(`/api/room/${CODE}/speaking`, { on: false }); S.speaking = false; }
      setOrb('listening'); setStatus(idleText());
    }
  }
}
function stopSpeech({ announce = true } = {}) {
  S.speechToken++;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (S.activeAudio) {
    const current = S.activeAudio;
    S.activeAudio = null;
    current.audio.pause();
    current.finish(false);
  }
  if (isGuide && S.speaking) {
    S.speaking = false;
    api(`/api/room/${CODE}/speaking`, { on: false });
  }
  if (announce) {
    setOrb('listening'); setStatus(idleText());
    toast('Okay — I stopped speaking.');
  }
}
function isStopPhrase(text) {
  const normalized = String(text).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  return /\b(thank|thanks)\s+(you\s+)?(mentaur|mentor|mental|manta|man\s*tour)\b/.test(normalized);
}
function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR(); r.lang = 'en-US'; r.interimResults = true; r.continuous = false;
  r.onstart = () => { S.recogActive = true; };
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript.trim();
      if (e.results[i].isFinal) S.micDraft = `${S.micDraft} ${transcript}`.trim();
      else interim += ` ${transcript}`;
    }
    const heard = `${S.micDraft} ${interim}`.trim();
    if (!heard) return;
    if (isStopPhrase(heard)) {
      stopSpeech();
      S.micDraft = '';
      S.micEnding = false;
      stopMicCapture();
      return;
    }
    $('#replyBox').value = heard;
    api(`/api/room/${CODE}/activity`, { typing: true });
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      S.micBlocked = true;
      toast('Microphone permission is blocked in the browser.');
    }
  };
  r.onend = () => {
    S.recogActive = false;
    if (S.micEnding) {
      S.micEnding = false;
      const text = S.micDraft.trim();
      S.micDraft = '';
      if (text) {
        S.voiceAnswerSubmitted = true;
        $('#replyBox').value = text;
        submitReply();
      }
    } else if (S.micOn && !S.micBlocked) {
      try { S.recog.start(); } catch { /* retry on the next hold */ }
    }
  };
  return r;
}

function startMicCapture() {
  if (!S.recog || S.recogActive || S.micBlocked) return;
  S.micOn = true;
  S.micEnding = false;
  S.micDraft = '';
  $('#pushToTalk').classList.add('active');
  setStatus('Listening to your voice…');
  api(`/api/room/${CODE}/activity`, { typing: true });
  S.recog.lang = BCP47[isGuide ? S.guideLanguage : 'en'] || 'en-US';
  try { S.recog.start(); } catch { /* browser is still starting/stopping */ }
}
function stopMicCapture() {
  if (!S.micOn) return;
  S.micOn = false;
  $('#pushToTalk').classList.remove('active');
  api(`/api/room/${CODE}/activity`, { typing: false });
  if (S.recogActive) {
    S.micEnding = true;
    try { S.recog.stop(); } catch { S.micEnding = false; }
  }
}

/* ---------- orb/status/toast ---------- */
function setOrb(m) { $('#orb').className = 'orb ' + m; }
function setStatus(t) { $('#statusline').textContent = t; }
function idleText() {
  if (S.phase === 'practice') return 'Coaching — I’ll step in before a mistake';
  if (isGuide) {
    if (S.questionsPaused) return 'Question mode paused';
    return S.pending ? 'Waiting for your answer…' : 'Listening — I’ll ask only at a pause';
  }
  return 'Watching the guide — ask anytime';
}
function toast(msg, kind) { const t = $('#toast'); t.innerHTML = msg; t.className = 'toast show' + (kind ? ' ' + kind : ''); clearTimeout(t._tm); t._tm = setTimeout(() => (t.className = 'toast'), 2600); }

/* ---------- redact + transcript ---------- */
function redact(t) {
  if (!S.redact || typeof t !== 'string') return t;
  return t.replace(/€\s?[\d.,]+/g, '<span class="redacted">€●●●</span>')
    .replace(/\b(Baumann Maschinen GmbH|Novák s\.r\.o\.[^,)]*|Weber Supplies|Hartmann Werkzeug AG)\b/g, '<span class="redacted">████████</span>');
}
function addMsg(role, text, opts = {}) {
  const tr = $('#transcript'); const m = el('div', 'msg ' + role);
  if (role !== 'event') m.appendChild(el('div', 'lbl', opts.lbl || (role === 'agent' ? 'Mentaur' : role === 'guide' ? 'Guide' : role === 'student' ? 'Student' : 'Session')));
  m.appendChild(el('div', 'bubble', redact(text) + (opts.guardrail ? ' <span class="guardtag">WHEN TO STOP</span>' : '')));
  tr.appendChild(m); tr.scrollTop = tr.scrollHeight; return m;
}

/* ---------- activity ---------- */
let actTimer = null;
function reportActivity(typing) { if (!isGuide) return; clearTimeout(actTimer); api(`/api/room/${CODE}/activity`, { typing: !!typing }); if (typing) actTimer = setTimeout(() => api(`/api/room/${CODE}/activity`, { typing: false }), 1200); }

let ocrWorkerPromise;
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    ocrWorkerPromise = import('/vendor/tesseract/tesseract.esm.min.js')
      .then(({ createWorker }) => createWorker('eng', 1, {
        workerPath: '/vendor/tesseract/worker.min.js',
        corePath: '/vendor/tesseract/tesseract-core-lstm.wasm.js',
        langPath: 'https://tessdata.projectnaptha.com/4.0.0',
      }));
  }
  return ocrWorkerPromise;
}

function containsSensitiveText(text) {
  return /\b[\w.+-]+@[\w-]+\.[\w.-]+\b|\b(?:\+?\d[\d\s().-]{7,}\d)\b|€\s?[\d.,]+|\bIBAN[:\s]*[A-Z]{2}\d{2}[A-Z0-9]{10,}\b|Baumann Maschinen GmbH|Novák s\.r\.o\.|Weber Supplies|Hartmann Werkzeug AG/i.test(text);
}

async function redactSharedCanvas(canvas) {
  if (!S.redact) return canvas;
  const ctx = canvas.getContext('2d');
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(canvas);
    for (const line of data.lines || []) {
      if (!containsSensitiveText(line.text)) continue;
      const pad = 4;
      const x = Math.max(0, line.bbox.x0 - pad);
      const y = Math.max(0, line.bbox.y0 - pad);
      const w = Math.min(canvas.width - x, line.bbox.x1 - line.bbox.x0 + pad * 2);
      const h = Math.min(canvas.height - y, line.bbox.y1 - line.bbox.y0 + pad * 2);
      ctx.fillStyle = '#111';
      ctx.fillRect(x, y, w, h);
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.max(12, Math.round(h * 0.65))}px sans-serif`;
      ctx.fillText('[REDACTED]', x + 3, y + Math.max(12, Math.round(h * 0.72)));
    }
  } catch (err) {
    console.warn('Screen redaction unavailable; hiding this frame:', err);
    ctx.fillStyle = '#111';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#111';
    ctx.fillStyle = '#fff';
    ctx.font = '20px sans-serif';
    ctx.fillText('[SCREEN HIDDEN: REDACTION UNAVAILABLE]', 16, 32);
  }
  return canvas;
}

/* ============================================================
   SSE — the room talks to both roles here
   ============================================================ */
function connect() {
  const es = new EventSource(`/api/room/${CODE}/stream?role=${ROLE}`);
  es.onmessage = (m) => {
    const d = JSON.parse(m.data);
    switch (d.type) {
      case 'hello': setStatus(idleText()); break;
      case 'presence': renderPresence(d.presence); break;
      case 'event': onEvent(d); break;
      case 'frame': onFrame(d.frame, d.seq); break;
      case 'ask': onAsk(d); break;
      case 'ack': onAck(d); break;
      case 'chat': onChat(d.msg); break;
      case 'suggestions': renderSuggestions(d.suggestions); break;
      case 'debrief_ready': if (isGuide) offerDebrief(); break;
      case 'teachback': if (isGuide) startTeachback(d.steps); else waitForCurriculum(); break;
      case 'curriculum': onCurriculum(d); break;
      case 'phase': onPhase(d.phase); break;
      case 'practice_catch': onPracticeCatch(d); break;
      case 'practice_done': onPracticeDone(d); break;
      case 'redact': break;
      case 'question_mode': onQuestionMode(d.paused); break;
      case 'share_state': onShareState(d); break;
      case 'language': onLanguage(d.role, d.lang); break;
    }
  };
}
function onEvent(d) {
  addMsg('event', '▸ ' + fmt(d.event.t) + '  ' + d.event.text);
  if (d.invoices) { S.invoices = d.invoices; if (S.phase === 'capture') renderQueue(); if (S.selected) renderEditor(); }
}
async function onAsk(d) {
  const guideText = d.questionLocal || d.question;
  if (d.repeat && S.pending && S.pending.question === d.question) {
    addMsg('agent', `I’m still waiting — ${guideText}`, { guardrail: d.guardrail });
  } else {
    S.pending = d;
    S.voiceAnswerSubmitted = false;
    if (isGuide) addMsg('agent', guideText, { guardrail: d.guardrail });
  }
  if (isGuide) {
    await speak(d.repeat ? `I’m still waiting for your answer. ${guideText}` : guideText, S.guideLanguage);
    setStatus('Waiting for your answer…');
  }
  else { addMsg('agent', d.question, { guardrail: d.guardrail, lbl: 'Apprentice → Guide' }); }
}
function onAck(d) {
  if (isGuide) {
    const spoken = d.spoken || (d.guardrail ? 'Got it — I’ll treat that as a guardrail.' : 'Got it — that helps me understand the decision.');
    addMsg('agent', spoken);
    speak(spoken, S.guideLanguage);
  }
  S.pending = null; S.voiceAnswerSubmitted = false; renderCoverage(d.coverage);
}
/* ---------- language ---------- */
const LANG_NAME = { en: 'English', ja: 'Japanese', vi: 'Vietnamese' };
function renderLanguageUI() {
  $('#langPicker').style.display = 'flex';
  $('#langIndicator').style.display = 'none';
  $('#langLabel').textContent = isGuide ? 'Your language' : 'Your language';
  const selected = isGuide ? S.guideLanguage : S.studentLanguage;
  document.querySelectorAll('.lang-opt').forEach((b) => b.classList.toggle('active', b.dataset.lang === selected));
}
function onLanguage(role, lang) {
  if (role === 'student') S.studentLanguage = lang;
  else S.guideLanguage = lang;
  renderLanguageUI();
}
async function setGuideLanguage(lang) {
  if (lang === S.guideLanguage) return;
  S.guideLanguage = lang; renderLanguageUI();
  await api(`/api/room/${CODE}/language`, { lang, role: 'guide' });
  toast(lang === 'en' ? 'Explaining in English' : `Explaining in ${LANG_NAME[lang]}`);
}
async function setStudentLanguage(lang) {
  if (lang === S.studentLanguage) return;
  S.studentLanguage = lang; renderLanguageUI();
  await api(`/api/room/${CODE}/language`, { lang, role: 'student' });
  toast(lang === 'en' ? 'Showing English' : `Showing ${LANG_NAME[lang]}`);
}
document.querySelectorAll('.lang-opt').forEach((btn) => btn.addEventListener('click', () => isGuide ? setGuideLanguage(btn.dataset.lang) : setStudentLanguage(btn.dataset.lang)));

function onChat(msg, { speakStudentQuestion = true, speakAgent = true } = {}) {
  if (msg.from === 'guide') {
    const displayText = isGuide ? (msg.guideText || msg.original || msg.text) : (msg.studentText || msg.text);
    const opts = !isGuide && S.studentLanguage !== S.guideLanguage
      ? { lbl: `Guide · translated to ${LANG_NAME[S.studentLanguage]}` } : {};
    addMsg('guide', displayText, opts);
  }
  else if (msg.from === 'student') {
    const displayText = isGuide ? (msg.guideText || msg.text) : (msg.studentText || msg.text);
    const opts = isGuide && S.studentLanguage !== S.guideLanguage
      ? { lbl: `Student · translated to ${LANG_NAME[S.guideLanguage]}` } : {};
    addMsg(isGuide ? 'student' : 'user', displayText, opts);
    if (speakStudentQuestion && S.phase !== 'practice') {
      speak(displayText, isGuide ? S.guideLanguage : S.studentLanguage);
    }
    if (isGuide) toast('Student asked a question');
  }
  else if (msg.from === 'activity') addMsg('activity', msg.text, { lbl: 'Live activity · Claude' });
  else {
    addMsg('agent', msg.text);
    if (!isGuide && speakAgent) speak(msg.text);
  }
}

/* ============================================================
   boot
   ============================================================ */
async function boot() {
  S.config = await api('/api/config');
  S.costCenters = S.config.costCenters;
  $('#modePill').textContent = `${S.config.visionMode}/${S.config.voiceMode}`;
  $('#roomCode').textContent = CODE;
  $('#roomCode').onclick = () => { navigator.clipboard?.writeText(`${location.origin}/room.html?code=${CODE}&role=student`); toast('Student invite link copied'); };
  $('#roleSub').textContent = isGuide ? 'Guide · Mentaur is learning from you' : 'Student · Mentaur is coaching you';
  $('#agentName').textContent = 'Apprentice';
  $('#replyBox').placeholder = isGuide ? 'Answer Mentaur or add context…' : 'Ask Mentaur or the Guide…';
  S.recog = initMic();

  const view = await api(`/api/room/${CODE}`);
  if (view.error) { $('#surface').innerHTML = `<div class="intro"><h3>Room not found</h3><p>The code <b>${CODE}</b> isn’t active. <a href="/">Go back</a> and check it.</p></div>`; return; }
  S.invoices = view.invoices; S.phase = view.phase; S.curriculum = view.curriculum; S.workMap = view.workMap;
  S.questionsPaused = !!view.controls?.questionsPaused; S.sharePaused = !!view.controls?.shareState?.paused; S.sharing = !!view.controls?.shareState?.sharing;
  S.guideLanguage = view.guideLanguage || 'en';
  S.studentLanguage = view.studentLanguage || 'en';
  renderLanguageUI();
  renderPresence(view.presence);
  connect();

  if (S.phase === 'curriculum' || S.phase === 'practice') renderCurriculum();
  else if (isGuide) renderGuideCapture();
  else renderStudentLive();
  if (S.phase === 'capture') onShareState(view.controls?.shareState || { sharing: false, paused: false });
  setOrb('listening'); setStatus(idleText());
  const greeting = "Hi, I'm Mentaur. I'll assist you during this session.";
  addMsg('agent', greeting);
  await speak(greeting);
  // replay recent transcript for late joiners
  view.chat.forEach((msg) => onChat(msg, { speakStudentQuestion: false, speakAgent: false }));
  renderSuggestions(view.suggestions);
  if (!isGuide && view.latestFrame) onFrame(view.latestFrame);
}

/* ============================================================
   GUIDE — live capture
   ============================================================ */
function renderGuideCapture() {
  S.phase = 'capture'; setPhase('capture');
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Receive inventory</h2><div class="lead">Review three items, choose stock, reorder, or quarantine, then complete the matching action. Mentaur asks about the judgment behind each choice.</div></div><span class="pill" id="progressPill">0 of ${S.invoices.length} processed</span>`));
  const preview = el('section', 'guide-share-preview hidden'); preview.id = 'guideSharePreview';
  preview.innerHTML = `<div class="guide-preview-head"><div><b>Your shared screen</b><span>Live preview of exactly what Mentaur is observing.</span></div><span class="pill live" id="guidePreviewPill">● sharing</span></div><div class="mirror guide-mirror"><video id="shareVid" muted autoplay playsinline></video><div class="mirror-state hidden" id="guideMirrorState"></div></div>`;
  s.appendChild(preview);
  const erp = el('div', 'erp');
  erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Sandbox workspace · Inventory receiving <span class="tag">capture mode</span>`));
  const q = el('div', 'queue'); q.id = 'queue'; erp.appendChild(q); s.appendChild(erp);
  s.appendChild(Object.assign(el('div'), { id: 'editorMount' }));
  const sb = el('div', 'sharebar');
  sb.innerHTML = `<div class="share-controls"><button class="btn ghost" id="shareBtn">▣ Share real screen</button><button class="btn ghost" id="sharePauseBtn" disabled>⏸ Pause share</button><button class="btn ghost" id="questionModeBtn">❚❚ Pause questions</button></div><span class="hint">Share any work screen. Mentaur analyzes changed frames with Claude, logs concise activity summaries in chat, refreshes learner prompts live, and can ask a spoken question after learner silence. Use fake/sandbox data for the demo.</span>`;
  s.appendChild(sb);
  $('#shareBtn').onclick = shareScreen;
  $('#sharePauseBtn').onclick = toggleSharePause;
  $('#questionModeBtn').onclick = toggleQuestionMode;
  renderCaptureControls();
  renderQueue(); $('#coverageBox').style.display = 'block'; renderCoverage([]);
  addMsg('system', 'Session started. Review the inventory items — I’m watching.');
  reportActivity(false);
}
function renderQueue() {
  const q = $('#queue'); if (!q) return; q.innerHTML = '';
  S.invoices.forEach((inv) => {
    const row = el('div', 'inv' + (S.selected === inv.id ? ' selected' : '') + (inv.action ? ' done' : ''));
    if (isGuide) row.onclick = () => selectInvoice(inv.id);
    const stMap = { approve: ['approved', 'Stocked'], hold: ['held', 'Quarantined'], escalate: ['escalated', 'Reorder queued'] };
    const [cls, txt] = inv.action ? stMap[inv.action] : ['open', 'Open'];
    const decision = { stock: 'Stock', reorder: 'Reorder', quarantine: 'Quarantine' }[inv.cc] || 'Pending';
    row.innerHTML = `<div class="item-photo" aria-hidden="true">${inv.photo || '📦'}</div><div class="id">${inv.id}</div><div><div class="who">${redact(inv.desc)}</div><div class="meta">${inv.amount} units · ${inv.country} · ${inv.condition || 'condition unknown'}</div></div><div style="display:flex;align-items:center;gap:14px"><div class="amt">${decision}</div><div class="state ${cls}">${txt}</div></div>`;
    q.appendChild(row);
  });
  const done = S.invoices.filter((i) => i.action).length;
  $('#progressPill') && ($('#progressPill').textContent = `${done} of ${S.invoices.length} processed`);
}
function selectInvoice(id) { stopSpeech({ announce: false }); S.selected = id; reportActivity(false); api(`/api/room/${CODE}/change`, { invId: id, trigger: 'open' }); renderQueue(); renderEditor(); }
function renderEditor() {
  const mount = $('#editorMount'); if (!mount) return; mount.innerHTML = '';
  const inv = S.invoices.find((i) => i.id === S.selected); if (!inv) return;
  const dis = inv.action || !isGuide ? 'disabled' : '';
  const ed = el('div', 'editor');
  ed.innerHTML = `
    <div class="editor-head"><span class="id">${inv.id}</span><h3>${redact(inv.supplier)}</h3><span class="state ${inv.action || 'open'}" style="margin-left:auto">${inv.action || 'Open'}</span></div>
    <div class="editor-body">
      <div class="field"><label>Item</label><div class="val">${inv.photo || '📦'} ${inv.desc}</div><div class="valsub">${inv.condition || 'condition unknown'}</div></div>
      <div class="field"><label>Count</label><div class="val">${inv.amount} units</div><div class="valsub">Location: ${inv.country}</div></div>
      <div class="field"><label>Receiving note</label><div class="valsub">${inv.note || 'No note recorded.'}</div></div>
      <div class="field"><label>Inventory decision</label><select id="ccSel" ${dis}>${S.costCenters.map((c) => `<option value="${c.v}" ${inv.cc === c.v ? 'selected' : ''}>${c.t}</option>`).join('')}</select></div>
      <div class="actions-row">
        <button class="btn primary" id="approveBtn" ${dis}>✓ Put into stock</button>
        <button class="btn warn" id="holdBtn" ${dis}>⏸ Quarantine</button>
        <button class="btn esc" id="escBtn" ${dis}>↻ Reorder</button>
      </div>
    </div>`;
  mount.appendChild(ed);
  if (!isGuide) return;
  $('#ccSel').onchange = (e) => { inv.cc = e.target.value; api(`/api/room/${CODE}/change`, { invId: inv.id, trigger: 'cc', cc: inv.cc }); };
  $('#approveBtn').onclick = () => doAction(inv, 'approve');
  $('#holdBtn').onclick = () => doAction(inv, 'hold');
  $('#escBtn').onclick = () => doAction(inv, 'escalate');
}
async function doAction(inv, action) { stopSpeech({ announce: false }); inv.action = action; const v = await api(`/api/room/${CODE}/change`, { invId: inv.id, trigger: 'action', action }); S.invoices = v.invoices; renderQueue(); renderEditor(); renderCoverage(v.coverage); }

/* screen share + Claude vision */
function renderCaptureControls() {
  const p = $('#sharePauseBtn');
  if (p) {
    p.disabled = !S.shareStream;
    p.textContent = S.sharePaused ? '▶ Resume share' : '⏸ Pause share';
    p.classList.toggle('control-active', S.sharePaused);
  }
  const q = $('#questionModeBtn');
  if (q) {
    q.textContent = S.questionsPaused ? '▶ Resume questions' : '❚❚ Pause questions';
    q.classList.toggle('control-active', S.questionsPaused);
  }
}

async function toggleQuestionMode() {
  S.questionsPaused = !S.questionsPaused;
  renderCaptureControls(); setStatus(idleText());
  await api(`/api/room/${CODE}/question-mode`, { paused: S.questionsPaused });
  toast(S.questionsPaused ? 'Question mode paused' : 'Question mode resumed');
}

function onQuestionMode(paused) {
  S.questionsPaused = !!paused;
  renderCaptureControls(); setStatus(idleText());
}

async function toggleSharePause() {
  if (!S.shareStream) return;
  S.sharePaused = !S.sharePaused;
  renderCaptureControls();
  await api(`/api/room/${CODE}/share-state`, { sharing: true, paused: S.sharePaused });
  toast(S.sharePaused ? 'Screen sharing paused in Mentaur' : 'Screen sharing resumed');
}

function onShareState(d) {
  S.sharing = d.sharing !== false; S.sharePaused = !!d.paused;
  if (d.sharing === false) {
    S.pending = null;
    stopSpeech({ announce: false });
  }
  if (isGuide) {
    renderCaptureControls();
    const state = $('#guideMirrorState');
    const pill = $('#guidePreviewPill');
    if (state) {
      state.textContent = d.sharing === false ? 'Screen share stopped' : d.paused ? 'Mentaur relay + analysis paused' : '';
      state.classList.toggle('hidden', d.sharing !== false && !d.paused);
    }
    if (pill) pill.textContent = d.paused ? '● paused' : '● sharing';
  }
  const badge = $('#mirrorState');
  if (badge) {
    badge.textContent = d.sharing === false ? 'Screen share stopped' : d.paused ? 'Screen share paused' : '';
    badge.classList.toggle('hidden', d.sharing !== false && !d.paused);
  }
  if (d.sharing === false && !isGuide) {
    const img = $('#mirrorImg');
    img?.classList.add('hidden');
    $('#mirrorEmpty')?.classList.remove('hidden');
    S.lastFrameSeq = 0;
  }
}

async function shareScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false });
    S.shareStream = stream; S.sharing = true; S.sharePaused = false; S.lastVisualFingerprint = null; S.visionDirty = true; S.lastVisionSentAt = 0;
    const v = $('#shareVid'); v.srcObject = stream;
    $('#guideSharePreview')?.classList.remove('hidden');
    try { await v.play(); } catch {}
    $('#shareBtn').textContent = '▣ Sharing'; $('#shareBtn').disabled = true;
    renderCaptureControls();
    await api(`/api/room/${CODE}/share-state`, { sharing: true, paused: false });
    startFrameLoop(v);
    stream.getVideoTracks()[0].addEventListener('ended', async () => {
      S.shareStream = null; S.sharing = false; S.sharePaused = false; S.lastVisualFingerprint = null; S.visionDirty = false;
      S.pendingRelay = null;
      v.srcObject = null; $('#guideSharePreview')?.classList.add('hidden');
      $('#shareBtn').textContent = '▣ Share real screen'; $('#shareBtn').disabled = false;
      renderCaptureControls();
      await api(`/api/room/${CODE}/share-state`, { sharing: false, paused: false });
    });
  } catch { toast('Screen share cancelled.'); }
}

function fingerprint(video, canvas) {
  canvas.width = 32; canvas.height = 18;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, 0, 0, 32, 18);
  const data = ctx.getImageData(0, 0, 32, 18).data;
  const fp = new Uint8Array(32 * 18);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) fp[j] = Math.round((data[i] + data[i + 1] + data[i + 2]) / 3);
  return fp;
}
function fingerprintDelta(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (a.length * 255);
}
function captureFrame(video, canvas) {
  const srcW = video.videoWidth || 1280, srcH = video.videoHeight || 720;
  const w = Math.min(1280, srcW), h = Math.max(1, Math.round((srcH / srcW) * w));
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return canvas;
}

function startFrameLoop(video) {
  const probe = document.createElement('canvas');
  const frameCanvas = document.createElement('canvas');
  const visionCanvas = document.createElement('canvas');
  const sendRelay = async (dataUrl) => {
    const seq = ++S.frameSeq;
    try {
      await api(`/api/room/${CODE}/frame`, { frame: dataUrl, seq });
    } finally {
      S.relayInFlight = false;
      const next = S.pendingRelay;
      S.pendingRelay = null;
      if (next && S.shareStream?.active) relayFrame(next);
    }
  };
  const relayFrame = (canvas) => {
    const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
    if (S.relayInFlight) {
      S.pendingRelay = dataUrl;
      return;
    }
    S.relayInFlight = true;
    sendRelay(dataUrl);
  };
  const redactAndRelay = async () => {
    if (S.redactionBusy || Date.now() - S.lastRedactionAt < 900) return;
    S.redactionBusy = true;
    S.lastRedactionAt = Date.now();
    try {
      const canvas = captureFrame(video, frameCanvas);
      await redactSharedCanvas(canvas);
      await relayFrame(canvas);
    } finally {
      S.redactionBusy = false;
    }
  };
  const tick = async () => {
    if (!S.shareStream || !S.shareStream.active) return;
    if (S.sharePaused || video.readyState < 2 || !video.videoWidth) return setTimeout(tick, 500);

    const fp = fingerprint(video, probe);
    const delta = fingerprintDelta(S.lastVisualFingerprint, fp);
    const changed = !S.lastVisualFingerprint || delta >= 0.035;
    S.lastVisualFingerprint = fp;

    if (changed) {
      S.visionDirty = true;
      // This cheap activity ping is what keeps Mentaur quiet while the shared
      // screen is actively changing, even when Claude calls are throttled.
      reportActivity(false);
      if (S.redact) redactAndRelay();
      else relayFrame(captureFrame(video, frameCanvas));
    }

    const interval = Number(S.config?.visionIntervalMs) || 4000;
    if (S.config?.visionMode !== 'mock' && S.visionDirty && Date.now() - S.lastVisionSentAt >= interval) {
      const nextCanvas = captureFrame(video, visionCanvas);
      S.visionDirty = false; S.lastVisionSentAt = Date.now();
      if (S.redact) await redactSharedCanvas(nextCanvas);
      api('/api/vision', { code: CODE, next: nextCanvas.toDataURL('image/jpeg', 0.72) }).then((out) => {
        if (out?.error) console.warn('Vision analysis skipped:', out.error);
      }).catch(() => { S.visionDirty = true; });
    }
    setTimeout(tick, 500);
  };
  setTimeout(tick, 700);
}

/* ============================================================
   STUDENT — live mirror
   ============================================================ */
function renderStudentLive() {
  S.phase = 'capture'; setPhase('capture');
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Follow inventory receiving</h2><div class="lead">Watch the Guide decide what to stock, reorder, or quarantine.</div></div><span class="pill live">● live</span>`));
  const frame = el('div', 'mirror'); frame.id = 'mirror';
  frame.innerHTML = `<img id="mirrorImg" class="hidden" alt="guide screen"><div class="mirror-empty" id="mirrorEmpty">The guide’s screen appears here when they share it.</div><div class="mirror-state hidden" id="mirrorState"></div>`;
  s.appendChild(frame);
  const erp = el('div', 'erp');   erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Inventory workspace <span class="tag">live mirror</span>`));
  const q = el('div', 'queue'); q.id = 'queue'; erp.appendChild(q); s.appendChild(erp);
  renderQueue();
  $('#suggestions').style.display = 'block';
}
function onFrame(dataUrl, seq = 0) {
  if (seq && seq <= S.lastFrameSeq) return;
  S.lastFrameSeq = seq || S.lastFrameSeq + 1;
  const img = $('#mirrorImg'); if (!img) return;
  img.src = dataUrl; img.classList.remove('hidden'); $('#mirrorEmpty')?.classList.add('hidden');
}

/* ---------- suggestions (student) ---------- */
function renderSuggestions(list) {
  if (isGuide) return;
  const box = $('#suggestions'), wrap = $('#suggestList'); if (!wrap) return;
  if (S.suggestionsHidden) { box.style.display = 'none'; return; }
  if (!list || !list.length) { box.style.display = S.phase === 'capture' ? 'block' : 'none'; wrap.innerHTML = '<div class="covrow" style="color:#8a93a1">Suggestions appear as the guide works…</div>'; return; }
  box.style.display = 'block'; wrap.innerHTML = '';
  list.forEach((sg) => { const b = el('button', 'suggchip', redact(sg.q)); b.onclick = () => { $('#replyBox').value = sg.q; submitReply(); }; wrap.appendChild(b); });
}

/* ---------- coverage ---------- */
function renderCoverage(items) {
  S._cov = items || S._cov || [];
  const list = $('#coverageList'); if (!list) return;
  if (!isGuide) { $('#coverageBox').style.display = 'none'; return; }
  $('#coverageBox').style.display = 'block';
  if (!S._cov.length) { list.innerHTML = `<div class="covrow"><span class="covdot"></span> I’ll track gaps as you work.</div>`; return; }
  list.innerHTML = ''; S._cov.forEach((it) => { const r = el('div', 'covrow'); r.innerHTML = `<span class="covdot ${it.ok ? 'full' : ''}"></span> ${it.label}`; list.appendChild(r); });
}

/* ---------- debrief / teachback (guide) ---------- */
function offerDebrief() {
  addMsg('agent', 'Capture complete. Ready for a quick debrief to close the remaining knowledge gaps?');
  speak('Capture complete. Ready for a quick debrief?');
  const bar = el('div'); bar.style.marginTop = '16px'; bar.innerHTML = `<button class="btn primary" id="startDebrief">Map the workflow →</button>`;
  $('#surface').appendChild(bar);
  $('#startDebrief').onclick = async () => { $('#startDebrief').remove(); await api(`/api/room/${CODE}/debrief`, {}); };
}
function startTeachback(steps) {
  S.phase = 'teachback';
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', "<div><h2>Confirm the Work Map</h2><div class='lead'>Mentaur has reconstructed the workflow from the screen events and your explanations. Confirm it before it becomes the Student’s playbook.</div></div>"));
  const lines = steps.map((st, i) => `${i + 1}. ${st.title}: ${st.decision} — because “${st.reason}”. When to stop: ${st.guardrail}`);
  const card = el('div', 'intro');
  card.innerHTML = `<h3>What Mentaur learned</h3><ol>${lines.map((l) => `<li>${redact(l)}</li>`).join('')}</ol><button class="btn primary" id="confirmTB">✓ Confirm & build the playbook</button>`;
  s.appendChild(card);
  addMsg('agent', 'I prepared a Work Map from your demo session. Review it on the left and confirm it.');
  speak('I prepared a Work Map from your demo session. It is available for the new hire.');
  $('#confirmTB').onclick = async () => { addMsg('guide', 'Yes, that’s how it works.'); await api(`/api/room/${CODE}/confirm`, {}); };
}
function waitForCurriculum() { const s = $('#surface'); s.innerHTML = `<div class="intro"><h3>Building the shared playbook…</h3><p>The Guide is confirming the Work Map. This page updates automatically when it is ready.</p></div>`; }

/* ---------- curriculum (both) ---------- */
function onCurriculum(d) { S.curriculum = d.curriculum; S.workMap = d.workMap; renderCurriculum(); }
function onPhase(phase) { S.phase = phase; if (phase === 'curriculum') { if (!S.curriculum) api(`/api/room/${CODE}/curriculum`).then((d) => { S.curriculum = d.curriculum; S.workMap = d.workMap; renderCurriculum(); }); } if (phase === 'practice' && !isGuide) {/* guide started practice elsewhere */} }
async function renderCurriculum() {
  setPhase('curriculum');
  if (!S.curriculum) { const d = await api(`/api/room/${CODE}/curriculum`); S.curriculum = d.curriculum; S.workMap = d.workMap; }
  const c = S.curriculum; const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>${c.title}</h2><div class="lead">${redact(c.summary)}</div></div><a class="btn" href="/api/room/${CODE}/export" download>↓ Export agent JSON</a>`));
  const list = el('div', 'lessons');
  c.lessons.forEach((L) => {
    const card = el('div', 'lesson');
    card.innerHTML = `<div class="lesson-n">${L.n}</div><div class="lesson-body"><h3>${redact(L.title)}</h3>
      <div class="row2"><div class="k">Did</div><div>${redact(L.did)}</div></div>
      <div class="row2"><div class="k">Why</div><div class="quote">“${redact(L.reason)}”</div></div>
      <div class="row2"><div class="k">When to stop</div><div class="guardtext">${redact(L.guardrail)}</div></div>
      <div class="row2"><div class="k">Check</div><div>${redact(L.check)}</div></div></div>`;
    list.appendChild(card);
  });
  s.appendChild(list);
  if (Array.isArray(c.tutorial)) {
    const tutorial = el('div', 'intro');
    tutorial.innerHTML = `<h3>Step-by-step tutorial</h3><div class="tutorial-steps">${c.tutorial.map((t) => `<div class="tutorial-step"><b>${t.step}. ${redact(t.title)}</b><span>${redact(t.text)}</span></div>`).join('')}</div>`;
    s.appendChild(tutorial);
  }
  const cta = el('div'); cta.style.marginTop = '18px';
  if (!isGuide) cta.innerHTML = `<button class="btn primary big" id="startPractice">Start coached practice →</button>`;
  else cta.innerHTML = `<div class="hint" style="color:var(--muted)">The student can now practice. You’ll see their result here.</div>`;
  s.appendChild(cta);
  $('#suggestions').style.display = 'none'; $('#coverageBox').style.display = 'none';
  if (!isGuide) $('#startPractice').onclick = startPractice;
  addMsg('agent', isGuide ? 'The Work Map is ready and shared with the Student.' : 'The Work Map is ready. Start practice when you’re ready — I’ll coach you using the Guide’s reasoning.');
}

/* ---------- practice (student) ---------- */
async function startPractice() {
  const p = await api(`/api/room/${CODE}/practice`, { studentId: 's' });
  S.teach = p; S.phase = 'practice'; setPhase('practice');
  const inv = p.inv; const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Practice the inventory decision</h2><div class='lead'>This is an unseen item. Mentaur stays out of the way unless you are about to make an unsafe choice.</div></div><span class="pill">unseen item</span>`));
  const erp = el('div', 'erp');   erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Inventory workspace <span class="tag">Mentaur coaching</span>`)); s.appendChild(erp);
  s.appendChild(Object.assign(el('div'), { id: 'teachMount', style: 'margin-top:16px' }));
  renderPracticeEditor();
  const announcement = S.practiceStarted
    ? 'Next one!'
    : `New item: ${inv.id}, ${redact(inv.desc)}, ${inv.amount} units. I’ll let you drive.`;
  S.practiceStarted = true;
  addMsg('agent', announcement);
  speak(announcement);
  setStatus(idleText());
}
function renderPracticeEditor() {
  const inv = S.teach.inv; const mount = $('#teachMount'); mount.innerHTML = '';
  const ed = el('div', 'editor');
  ed.innerHTML = `<div class="editor-head"><span class="id">${inv.id}</span><h3>${redact(inv.supplier)}</h3><span class="state ${inv.action || 'open'}" style="margin-left:auto">${inv.action || 'Open'}</span></div>
    <div class="editor-body">
      <div class="field"><label>Item</label><div class="val">${inv.photo || '📦'} ${inv.desc}</div><div class="valsub">${inv.amount} units · ${inv.country} · ${inv.condition || 'condition unknown'}</div></div>
      <div class="field"><label>Receiving note</label><div class="valsub">${inv.note || 'No note recorded.'}</div></div>
      <div class="field"><label>Inventory decision</label><select id="tccSel" ${inv.action ? 'disabled' : ''}>${S.costCenters.map((c) => `<option value="${c.v}" ${inv.cc === c.v ? 'selected' : ''}>${c.t}</option>`).join('')}</select></div>
      <div class="field"><label>Predict</label><div class="valsub">What would your guide do?</div></div>
      <div class="actions-row"><button class="btn primary" id="tApprove" ${inv.action ? 'disabled' : ''}>✓ Put into stock</button><button class="btn warn" id="tHold" ${inv.action ? 'disabled' : ''}>⏸ Quarantine</button><button class="btn esc" id="tEsc" ${inv.action ? 'disabled' : ''}>↻ Reorder</button></div>
    </div>`;
  mount.appendChild(ed);
  $('#tccSel').onchange = (e) => { inv.cc = e.target.value; };
  $('#tApprove').onclick = () => practiceAttempt('approve');
  $('#tHold').onclick = () => practiceAttempt('hold');
  $('#tEsc').onclick = () => practiceAttempt('escalate');
}
async function practiceAttempt(action) { await api(`/api/room/${CODE}/practice-attempt`, { studentId: 's', cc: S.teach.inv.cc || '', action }); }
function onPracticeCatch(d) {
  if (isGuide) { toast('Coach caught the student before a mistake', 'guard'); addMsg('agent', '(coached the student) ' + d.question, { guardrail: true }); return; }
  addMsg('agent', d.question, { guardrail: true }); speak(d.question); toast('Caught before save', 'guard');
  const sel = $('#tccSel'); if (sel) { sel.classList.add('highlight-field'); setTimeout(() => sel.classList.remove('highlight-field'), 3400); }
}
function onPracticeDone(d) {
  if (isGuide) { addMsg('agent', 'The student finished the practice case.'); return; }
  const s = $('#surface'); const card = el('div', 'scorecard');
  const action = d.allComplete
    ? `<button class="btn primary" id="finishPractice">Finish simulation</button>`
    : `<button class="btn primary" id="nextPractice">Next practice case →</button>`;
  card.innerHTML = `<h3>Practice case complete</h3><div class="hint">${d.completedCases} of ${d.totalCases} cases completed.</div>${d.score.map((x) => `<div class="scorerow"><span class="ic ${x.ok ? 'ok' : 'miss'}">${x.ok ? '✓' : '!'}</span><div class="t"><b>${x.label}</b><div>${x.note}</div></div></div>`).join('')}<div style="margin-top:16px;display:flex;gap:10px">${action}<button class="btn ghost" id="backCur">← Work Map</button></div>`;
  s.appendChild(card);
  if (d.allComplete) {
    $('#finishPractice').onclick = () => {
      addMsg('agent', 'Congratulations — you finished all five inventory practice cases.');
      speak('Congratulations — you finished all five inventory practice cases.');
      $('#finishPractice').disabled = true;
    };
  } else {
    $('#nextPractice').onclick = startPractice;
  }
  $('#backCur').onclick = renderCurriculum;
  const allOk = d.score.every((x) => x.ok);
  const msg = allOk ? 'Nicely done — this case is complete.' : 'Good — you fixed it after I flagged it. That is the safety check to remember.';
  addMsg('agent', msg); speak(msg);
}

/* ---------- presence / phase chrome ---------- */
function renderPresence(pr) { $('#presence').innerHTML = `<span class="dotp ${pr.guide ? 'on' : ''}"></span>Guide <span class="dotp ${pr.students ? 'on' : ''}" style="margin-left:10px"></span>${pr.students} student${pr.students === 1 ? '' : 's'}`; }
function setPhase(p) { const order = ['capture', 'curriculum', 'practice']; document.querySelectorAll('.phase').forEach((ph) => { ph.classList.remove('active', 'done'); const name = ph.dataset.phase === 'capture' ? 'capture' : ph.dataset.phase; if (name === p || (p === 'teachback' && name === 'capture') || (p === 'debrief' && name === 'capture')) ph.classList.add('active'); if (order.indexOf(name) < order.indexOf(p)) ph.classList.add('done'); }); }

/* ---------- composer (both roles) ---------- */
async function submitReply() {
  const box = $('#replyBox'); const txt = box.value.trim(); if (!txt) return; box.value = '';
  S.micDraft = '';
  if (isGuide && S.speaking) stopSpeech({ announce: false });
  reportActivity(false);
  if (S.offRecord) { await api(`/api/room/${CODE}/offrecord`, { on: true }); S.offRecord = false; $('#offRecBtn').classList.remove('on'); }
  await api(`/api/room/${CODE}/chat`, { from: ROLE, text: txt, language: isGuide ? S.guideLanguage : S.studentLanguage });
}
$('#sendBtn').onclick = submitReply;
$('#replyBox').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply(); } });
$('#replyBox').addEventListener('input', (e) => {
  reportActivity(true);
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 112) + 'px';
});
const pushToTalk = $('#pushToTalk');
function beginPushToTalk(e) {
  if (e) e.preventDefault();
  if (!S.recog) S.recog = initMic();
  if (!S.recog) { toast('Voice input needs Chrome — use text.'); return; }
  startMicCapture();
}
function endPushToTalk(e) {
  if (e) e.preventDefault();
  stopMicCapture();
}
pushToTalk.addEventListener('pointerdown', beginPushToTalk);
pushToTalk.addEventListener('pointerup', endPushToTalk);
pushToTalk.addEventListener('pointercancel', endPushToTalk);
pushToTalk.addEventListener('keydown', (e) => { if (e.key === ' ' || e.key === 'Enter') beginPushToTalk(e); });
pushToTalk.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') endPushToTalk(e); });
document.addEventListener('keydown', (e) => {
  if (e.key !== ' ' || e.repeat || e.target.matches('textarea, input, button, select')) return;
  beginPushToTalk(e);
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') endPushToTalk(e); });
$('#redactToggle').addEventListener('change', async (e) => { S.redact = e.target.checked; await api(`/api/room/${CODE}/redact`, { on: S.redact }); toast(S.redact ? 'Redaction on' : 'Redaction off'); if ($('#queue')) renderQueue(); });
$('#offRecBtn').addEventListener('click', () => { S.offRecord = !S.offRecord; $('#offRecBtn').classList.toggle('on', S.offRecord); toast(S.offRecord ? 'Next answer off the record' : 'Back on the record'); });
$('#stopVoiceBtn').addEventListener('click', () => stopSpeech());
$('#exportPdfBtn').addEventListener('click', exportConversationPdf);

/* ---------- PDF export ---------- */
function exportConversationPdf() {
  const win = window.open('', '_blank');
  if (!win) { toast('Allow pop-ups to export the PDF.'); return; }

  const generatedAt = new Date().toLocaleString();
  const duration = fmt(Date.now() - S.started);
  const transcriptHtml = $('#transcript').innerHTML || '<p>No conversation yet.</p>';

  let curriculumHtml = '';
  if (S.curriculum) {
    const c = S.curriculum;
    curriculumHtml = `
      <h2>${c.title || 'Work Map'}</h2>
      <p class="pdf-summary">${c.summary || ''}</p>
      ${(c.lessons || []).map((L) => `
        <div class="pdf-lesson">
          <h3>${L.n}. ${L.title}</h3>
          <p><b>Did:</b> ${L.did}</p>
          <p><b>Why:</b> “${L.reason}”</p>
          <p><b>When to stop:</b> ${L.guardrail}</p>
          <p><b>Check:</b> ${L.check}</p>
        </div>`).join('')}`;
  }

  win.document.write(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Mentaur session ${CODE}</title>
<style>
  body{font-family:Arial,Helvetica,sans-serif;color:#1a1420;max-width:800px;margin:40px auto;padding:0 24px;line-height:1.55}
  h1{font-size:24px;margin-bottom:2px}
  .meta{color:#6b6470;font-size:13px;margin-bottom:28px}
  h2{font-size:18px;margin-top:32px;border-bottom:1px solid #ddd;padding-bottom:6px}
  .pdf-summary{font-size:13.5px;color:#4a4350}
  .msg{margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid #eee}
  .lbl{font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#595164;margin-bottom:3px}
  .bubble{font-size:13.5px}
  .guardtag{display:inline-block;margin-left:6px;font-size:9px;font-weight:800;background:#fff2d8;color:#7a5d00;padding:2px 6px;border-radius:999px}
  .redacted{background:#111;color:#111;border-radius:3px}
  .pdf-lesson{margin-bottom:18px}
  .pdf-lesson h3{font-size:14.5px;margin-bottom:4px}
  .pdf-lesson p{font-size:13px;margin:2px 0}
  @media print{ body{margin:0;padding:24px} }
</style></head>
<body>
  <h1>Mentaur — Conversation export</h1>
  <div class="meta">Room ${CODE} · ${isGuide ? 'Guide' : 'Student'} view · Session length ${duration} · Generated ${generatedAt}</div>
  <h2>Conversation</h2>
  <div class="pdf-transcript">${transcriptHtml}</div>
  ${curriculumHtml}
</body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 300);
}

/* ---------- scrape chatbot widget ---------- */
(function scrapeWidget() {
  const fab = $('#scrapeFab'), panel = $('#scrapePanel'), close = $('#scrapeClose');
  const log = $('#scrapeLog'), input = $('#scrapeInput'), send = $('#scrapeSend');
  if (!fab) return;
  // Scraped titles/summaries come from arbitrary third-party pages, so they're
  // rendered as plain text nodes only — never innerHTML — to avoid XSS.
  function addScrapeMsg(role, text) {
    const m = el('div', `scrape-msg ${role}`);
    m.textContent = text;
    log.appendChild(m); log.scrollTop = log.scrollHeight;
    return m;
  }
  function addScrapeResult(title, summary) {
    const m = el('div', 'scrape-msg bot');
    const strong = document.createElement('b'); strong.textContent = title;
    m.appendChild(strong);
    m.appendChild(document.createElement('br'));
    m.appendChild(document.createTextNode(summary));
    log.appendChild(m); log.scrollTop = log.scrollHeight;
  }
  const setOpen = (open) => { panel.classList.toggle('hidden', !open); fab.setAttribute('aria-expanded', String(open)); if (open) input.focus(); };
  fab.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
  close.addEventListener('click', () => setOpen(false));

  async function runScrape() {
    const url = input.value.trim();
    if (!url) return;
    input.value = ''; input.disabled = true; send.disabled = true;
    addScrapeMsg('user', url);
    const loading = addScrapeMsg('bot loading', 'Scraping via Bright Data…');
    try {
      const out = await api('/api/scrape', { url });
      loading.remove();
      if (out.error) addScrapeMsg('error', out.error);
      else addScrapeResult(out.title || out.url, out.summary);
    } catch {
      loading.remove();
      addScrapeMsg('error', 'Could not reach the scraping service.');
    } finally {
      input.disabled = false; send.disabled = false; input.focus();
    }
  }
  send.addEventListener('click', runScrape);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runScrape(); } });
})();

boot();
