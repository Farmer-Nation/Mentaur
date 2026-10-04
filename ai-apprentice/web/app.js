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
  speaking: false, micOn: false, recog: null, recogActive: false, micArmTimer: null,
  voiceAnswerSubmitted: false, micBlocked: false, curriculum: null, workMap: [],
  teach: null, shareStream: null, sharePaused: false, questionsPaused: false, sharing: false,
  lastVisualFingerprint: null, visionDirty: false, lastVisionSentAt: 0,
};

/* ---------- clock ---------- */
setInterval(() => { $('#sessionClock').textContent = fmt(Date.now() - S.started); }, 500);
function fmt(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

/* ---------- voice ---------- */
function localSpeak(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return setTimeout(resolve, 500 + text.length * 16);
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g, ''));
      u.rate = 1.02; u.onend = resolve; u.onerror = resolve; speechSynthesis.speak(u);
    } catch { resolve(); }
  });
}
async function speak(text) {
  if (!$('#ttsToggle').checked) return;
  if (isGuide) { await api(`/api/room/${CODE}/speaking`, { on: true }); S.speaking = true; }
  setOrb('speaking'); setStatus('Speaking…');
  try {
    // Prefer ElevenLabs whenever configured. Wait for playback to actually finish
    // before returning so the microphone never starts underneath Mentaur's voice.
    if (S.config && S.config.voiceMode.startsWith('elevenlabs')) {
      try {
        const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
        if (r.ok && r.headers.get('content-type')?.includes('audio')) {
          const url = URL.createObjectURL(await r.blob());
          const a = new Audio(url);
          const played = await new Promise((resolve) => {
            let settled = false;
            const finish = (ok) => { if (settled) return; settled = true; URL.revokeObjectURL(url); resolve(ok); };
            a.onended = () => finish(true);
            a.onerror = () => finish(false);
            a.play().catch(() => finish(false));
          });
          if (played) return;
        }
      } catch { /* use local TTS below */ }
    }
    await localSpeak(text);
  } finally {
    if (isGuide) { await api(`/api/room/${CODE}/speaking`, { on: false }); S.speaking = false; }
    setOrb('listening'); setStatus(idleText());
  }
}
function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR(); r.lang = 'en-US'; r.interimResults = false;
  r.onstart = () => { S.recogActive = true; };
  r.onresult = (e) => {
    S.voiceAnswerSubmitted = true;
    $('#replyBox').value = e.results[0][0].transcript;
    submitReply();
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      S.micBlocked = true;
      toast('Microphone permission is blocked in the browser.');
    }
  };
  r.onend = () => {
    S.recogActive = false;
    // SpeechRecognition is one-shot in Chromium. If the AI question is still
    // awaiting an answer, automatically re-arm instead of silently going dead.
    if (isGuide && S.micOn && S.pending && !S.speaking && !S.voiceAnswerSubmitted && !S.micBlocked) {
      armMic({ requirePending: true, delay: 220 });
    }
  };
  return r;
}

function armMic({ requirePending = false, delay = 0 } = {}) {
  clearTimeout(S.micArmTimer);
  S.micArmTimer = setTimeout(() => {
    if (!S.micOn || !S.recog || S.recogActive || S.speaking || S.micBlocked) return;
    if (requirePending && (!S.pending || S.voiceAnswerSubmitted)) return;
    try { S.recog.start(); }
    catch {
      // A recognizer can remain in its stopping state briefly. Retry only while
      // a still-unanswered AI question requires the microphone.
      if (requirePending && S.micOn && S.pending && !S.voiceAnswerSubmitted) armMic({ requirePending: true, delay: 250 });
    }
  }, delay);
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
  m.appendChild(el('div', 'bubble', redact(text) + (opts.guardrail ? ' <span class="guardtag">GUARDRAIL</span>' : '')));
  tr.appendChild(m); tr.scrollTop = tr.scrollHeight; return m;
}

/* ---------- activity ---------- */
let actTimer = null;
function reportActivity(typing) { if (!isGuide) return; clearTimeout(actTimer); api(`/api/room/${CODE}/activity`, { typing: !!typing }); if (typing) actTimer = setTimeout(() => api(`/api/room/${CODE}/activity`, { typing: false }), 1200); }

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
      case 'frame': onFrame(d.frame); break;
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
    }
  };
}
function onEvent(d) {
  addMsg('event', '▸ ' + fmt(d.event.t) + '  ' + d.event.text);
  if (d.invoices) { S.invoices = d.invoices; if (S.phase === 'capture') renderQueue(); if (S.selected) renderEditor(); }
}
async function onAsk(d) {
  S.pending = d;
  S.voiceAnswerSubmitted = false;
  if (isGuide) {
    addMsg('agent', d.question, { guardrail: d.guardrail });
    await speak(d.question);
    setStatus('Waiting for your answer…');
    if (S.micOn && S.recog && S.pending === d) armMic({ requirePending: true });
  }
  else { addMsg('agent', d.question, { guardrail: d.guardrail, lbl: 'Apprentice → Guide' }); }
}
function onAck(d) { if (isGuide) addMsg('agent', d.guardrail ? 'Got it — I’ll treat that as a guardrail.' : 'Thanks, that’s the reasoning I needed.'); S.pending = null; S.voiceAnswerSubmitted = false; renderCoverage(d.coverage); }
function onChat(msg) {
  if (msg.from === 'guide') addMsg('guide', msg.text);
  else if (msg.from === 'student') {
    addMsg('student', msg.text);
    if (isGuide) {
      toast('Student asked a question');
      if (S.micOn && S.recog && !S.speaking) armMic();
    }
  }
  else if (msg.from === 'activity') addMsg('activity', msg.text, { lbl: 'Live activity · Claude' });
  else addMsg('agent', msg.text);
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
  renderPresence(view.presence);
  connect();

  if (S.phase === 'curriculum' || S.phase === 'practice') renderCurriculum();
  else if (isGuide) renderGuideCapture();
  else renderStudentLive();
  if (S.phase === 'capture') onShareState(view.controls?.shareState || { sharing: false, paused: false });
  setOrb('listening'); setStatus(idleText());
  // replay recent transcript for late joiners
  view.chat.forEach(onChat);
  renderSuggestions(view.suggestions);
  if (!isGuide && view.latestFrame) onFrame(view.latestFrame);
}

/* ============================================================
   GUIDE — live capture
   ============================================================ */
function renderGuideCapture() {
  S.phase = 'capture'; setPhase('capture');
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Capture the real workflow</h2><div class="lead">Work the way you normally would. Mentaur watches quietly, records live activity, and asks grounded questions so the judgment behind each step is not lost.</div></div><span class="pill" id="progressPill">0 of 3 processed</span>`));
  const preview = el('section', 'guide-share-preview hidden'); preview.id = 'guideSharePreview';
  preview.innerHTML = `<div class="guide-preview-head"><div><b>Your shared screen</b><span>Live preview of exactly what Mentaur is observing.</span></div><span class="pill live" id="guidePreviewPill">● sharing</span></div><div class="mirror guide-mirror"><video id="shareVid" muted autoplay playsinline></video><div class="mirror-state hidden" id="guideMirrorState"></div></div>`;
  s.appendChild(preview);
  const erp = el('div', 'erp');
  erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Sandbox workspace · Accounts Payable <span class="tag">capture mode</span>`));
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
  addMsg('system', 'Session started. Work normally — I’m watching.');
  reportActivity(false);
}
function renderQueue() {
  const q = $('#queue'); if (!q) return; q.innerHTML = '';
  S.invoices.forEach((inv) => {
    const row = el('div', 'inv' + (S.selected === inv.id ? ' selected' : '') + (inv.action ? ' done' : ''));
    if (isGuide) row.onclick = () => selectInvoice(inv.id);
    const stMap = { approve: ['approved', 'Approved'], hold: ['held', 'Held'], escalate: ['escalated', '2nd approval'] };
    const [cls, txt] = inv.action ? stMap[inv.action] : ['open', 'Open'];
    row.innerHTML = `<div class="id">${inv.id}</div><div><div class="who">${redact(inv.supplier)}</div><div class="meta">${inv.desc} · ${inv.country}${inv.month ? ' · ' + inv.month : ''}</div></div><div style="display:flex;align-items:center;gap:14px"><div class="amt">${redact('€' + inv.amount.toLocaleString('de-DE'))}</div><div class="state ${cls}">${txt}</div></div>`;
    q.appendChild(row);
  });
  const done = S.invoices.filter((i) => i.action).length;
  $('#progressPill') && ($('#progressPill').textContent = `${done} of 3 processed`);
}
function selectInvoice(id) { S.selected = id; reportActivity(false); api(`/api/room/${CODE}/change`, { invId: id, trigger: 'open' }); renderQueue(); renderEditor(); }
function renderEditor() {
  const mount = $('#editorMount'); if (!mount) return; mount.innerHTML = '';
  const inv = S.invoices.find((i) => i.id === S.selected); if (!inv) return;
  const dis = inv.action || !isGuide ? 'disabled' : '';
  const ed = el('div', 'editor');
  ed.innerHTML = `
    <div class="editor-head"><span class="id">${inv.id}</span><h3>${redact(inv.supplier)}</h3><span class="state ${inv.action || 'open'}" style="margin-left:auto">${inv.action || 'Open'}</span></div>
    <div class="editor-body">
      <div class="field"><label>Description</label><div class="val">${inv.desc}</div></div>
      <div class="field"><label>Amount</label><div class="val">${redact('€' + inv.amount.toLocaleString('de-DE'))}</div><div class="valsub">${inv.category}${inv.month ? ' · booked ' + inv.month : ''}</div></div>
      <div class="field"><label>Supplier country</label><div class="val">${inv.country === 'CZ' ? 'Czech Republic (subsidiary)' : 'Germany'}</div></div>
      <div class="field"><label>Cost center</label><select id="ccSel" ${dis}>${S.costCenters.map((c) => `<option value="${c.v}" ${inv.cc === c.v ? 'selected' : ''}>${c.t}</option>`).join('')}</select></div>
      <div class="actions-row">
        <button class="btn primary" id="approveBtn" ${dis}>✓ Approve &amp; post</button>
        <button class="btn warn" id="holdBtn" ${dis}>⏸ Hold</button>
        <button class="btn esc" id="escBtn" ${dis}>⇅ 2nd approval</button>
      </div>
    </div>`;
  mount.appendChild(ed);
  if (!isGuide) return;
  $('#ccSel').onchange = (e) => { inv.cc = e.target.value; api(`/api/room/${CODE}/change`, { invId: inv.id, trigger: 'cc', cc: inv.cc }); };
  $('#approveBtn').onclick = () => doAction(inv, 'approve');
  $('#holdBtn').onclick = () => doAction(inv, 'hold');
  $('#escBtn').onclick = () => doAction(inv, 'escalate');
}
async function doAction(inv, action) { inv.action = action; const v = await api(`/api/room/${CODE}/change`, { invId: inv.id, trigger: 'action', action }); S.invoices = v.invoices; renderQueue(); renderEditor(); renderCoverage(v.coverage); }

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
  const w = Math.min(720, srcW), h = Math.max(1, Math.round((srcH / srcW) * w));
  canvas.width = w; canvas.height = h;
  canvas.getContext('2d').drawImage(video, 0, 0, w, h);
  return canvas.toDataURL('image/jpeg', 0.46);
}

function startFrameLoop(video) {
  const probe = document.createElement('canvas');
  const frameCanvas = document.createElement('canvas');
  const tick = async () => {
    if (!S.shareStream || !S.shareStream.active) return;
    if (S.sharePaused || video.readyState < 2 || !video.videoWidth) return setTimeout(tick, 1500);

    const fp = fingerprint(video, probe);
    const delta = fingerprintDelta(S.lastVisualFingerprint, fp);
    const changed = !S.lastVisualFingerprint || delta >= 0.035;
    S.lastVisualFingerprint = fp;

    if (changed) {
      S.visionDirty = true;
      // This cheap activity ping is what keeps Mentaur quiet while the shared
      // screen is actively changing, even when Claude calls are throttled.
      reportActivity(false);
      const relay = captureFrame(video, frameCanvas);
      api(`/api/room/${CODE}/frame`, { frame: relay });
    }

    const interval = Number(S.config?.visionIntervalMs) || 4000;
    if (S.config?.visionMode !== 'mock' && S.visionDirty && Date.now() - S.lastVisionSentAt >= interval) {
      const next = captureFrame(video, frameCanvas);
      S.visionDirty = false; S.lastVisionSentAt = Date.now();
      api('/api/vision', { code: CODE, next }).then((out) => {
        if (out?.error) console.warn('Vision analysis skipped:', out.error);
      }).catch(() => { S.visionDirty = true; });
    }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 700);
}

/* ============================================================
   STUDENT — live mirror
   ============================================================ */
function renderStudentLive() {
  S.phase = 'capture'; setPhase('capture');
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Follow the work live</h2><div class="lead">Watch the Guide’s decisions unfold in real time. Ask by voice or text, or use a suggested question when you want more context.</div></div><span class="pill live">● live</span>`));
  const frame = el('div', 'mirror'); frame.id = 'mirror';
  frame.innerHTML = `<img id="mirrorImg" class="hidden" alt="guide screen"><div class="mirror-empty" id="mirrorEmpty">The guide’s screen appears here when they share it.</div><div class="mirror-state hidden" id="mirrorState"></div>`;
  s.appendChild(frame);
  const erp = el('div', 'erp'); erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Guide workspace <span class="tag">live mirror</span>`));
  const q = el('div', 'queue'); q.id = 'queue'; erp.appendChild(q); s.appendChild(erp);
  renderQueue();
  $('#suggestions').style.display = 'block';
}
function onFrame(dataUrl) { const img = $('#mirrorImg'); if (!img) return; img.src = dataUrl; img.classList.remove('hidden'); $('#mirrorEmpty')?.classList.add('hidden'); }

/* ---------- suggestions (student) ---------- */
function renderSuggestions(list) {
  if (isGuide) return;
  const box = $('#suggestions'), wrap = $('#suggestList'); if (!wrap) return;
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
  const lines = steps.map((st, i) => `${i + 1}. ${st.title}: ${st.decision} — because “${st.reason}”. Guardrail: ${st.guardrail}`);
  const card = el('div', 'intro');
  card.innerHTML = `<h3>What Mentaur learned</h3><ol>${lines.map((l) => `<li>${redact(l)}</li>`).join('')}</ol><button class="btn primary" id="confirmTB">✓ Confirm & build the playbook</button>`;
  s.appendChild(card);
  addMsg('agent', 'I’ll explain it back — confirm on the left.');
  speak('Here’s how I understand your process. ' + lines.join('. '));
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
      <div class="row2"><div class="k">Guardrail</div><div class="guardtext">${redact(L.guardrail)}</div></div>
      <div class="row2"><div class="k">Check</div><div>${redact(L.check)}</div></div></div>`;
    list.appendChild(card);
  });
  s.appendChild(list);
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
  s.appendChild(el('div', 'surface-head', `<div><h2>Practice the judgment</h2><div class='lead'>This is a case your Guide never showed you. Mentaur will stay out of the way unless you’re about to cross a <b>guardrail</b>.</div></div><span class="pill">unseen case</span>`));
  const erp = el('div', 'erp'); erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Practice workspace <span class="tag">Mentaur coaching</span>`)); s.appendChild(erp);
  s.appendChild(Object.assign(el('div'), { id: 'teachMount', style: 'margin-top:16px' }));
  renderPracticeEditor();
  addMsg('agent', `New case: ${inv.id}, ${redact(inv.supplier)}, ${redact('€' + inv.amount.toLocaleString('de-DE'))}. I’ll let you drive.`);
  speak('New case loaded. I’ll let you drive.');
  setStatus(idleText());
}
function renderPracticeEditor() {
  const inv = S.teach.inv; const mount = $('#teachMount'); mount.innerHTML = '';
  const ed = el('div', 'editor');
  ed.innerHTML = `<div class="editor-head"><span class="id">${inv.id}</span><h3>${redact(inv.supplier)}</h3><span class="state ${inv.action || 'open'}" style="margin-left:auto">${inv.action || 'Open'}</span></div>
    <div class="editor-body">
      <div class="field"><label>Description</label><div class="val">${inv.desc}</div></div>
      <div class="field"><label>Amount</label><div class="val">${redact('€' + inv.amount.toLocaleString('de-DE'))}</div><div class="valsub">${inv.category}</div></div>
      <div class="field"><label>Cost center</label><select id="tccSel" ${inv.action ? 'disabled' : ''}>${S.costCenters.map((c) => `<option value="${c.v}" ${inv.cc === c.v ? 'selected' : ''}>${c.t}</option>`).join('')}</select></div>
      <div class="field"><label>Predict</label><div class="valsub">What would your guide do?</div></div>
      <div class="actions-row"><button class="btn primary" id="tApprove" ${inv.action ? 'disabled' : ''}>✓ Approve &amp; post</button><button class="btn warn" id="tHold" ${inv.action ? 'disabled' : ''}>⏸ Hold</button><button class="btn esc" id="tEsc" ${inv.action ? 'disabled' : ''}>⇅ 2nd approval</button></div>
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
  card.innerHTML = `<h3>Your mastery snapshot</h3>${d.score.map((x) => `<div class="scorerow"><span class="ic ${x.ok ? 'ok' : 'miss'}">${x.ok ? '✓' : '!'}</span><div class="t"><b>${x.label}</b><div>${x.note}</div></div></div>`).join('')}<div style="margin-top:16px;display:flex;gap:10px"><button class="btn" id="againBtn">↺ Try again</button><button class="btn ghost" id="backCur">← Work Map</button></div>`;
  s.appendChild(card);
  $('#againBtn').onclick = startPractice; $('#backCur').onclick = renderCurriculum;
  const allOk = d.score.every((x) => x.ok);
  const msg = allOk ? 'Nicely done — a case your guide never showed you.' : 'Good — you fixed it after I flagged it. That’s the guardrail to remember.';
  addMsg('agent', msg); speak(msg);
}

/* ---------- presence / phase chrome ---------- */
function renderPresence(pr) { $('#presence').innerHTML = `<span class="dotp ${pr.guide ? 'on' : ''}"></span>Guide <span class="dotp ${pr.students ? 'on' : ''}" style="margin-left:10px"></span>${pr.students} student${pr.students === 1 ? '' : 's'}`; }
function setPhase(p) { const order = ['capture', 'curriculum', 'practice']; document.querySelectorAll('.phase').forEach((ph) => { ph.classList.remove('active', 'done'); const name = ph.dataset.phase === 'capture' ? 'capture' : ph.dataset.phase; if (name === p || (p === 'teachback' && name === 'capture') || (p === 'debrief' && name === 'capture')) ph.classList.add('active'); if (order.indexOf(name) < order.indexOf(p)) ph.classList.add('done'); }); }

/* ---------- composer (both roles) ---------- */
async function submitReply() {
  const box = $('#replyBox'); const txt = box.value.trim(); if (!txt) return; box.value = '';
  reportActivity(false);
  if (S.offRecord) { await api(`/api/room/${CODE}/offrecord`, { on: true }); S.offRecord = false; $('#offRecBtn').classList.remove('on'); }
  await api(`/api/room/${CODE}/chat`, { from: ROLE, text: txt });
}
$('#sendBtn').onclick = submitReply;
$('#replyBox').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitReply(); } });
$('#replyBox').addEventListener('input', (e) => {
  reportActivity(true);
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 112) + 'px';
});
$('#micToggle').addEventListener('change', (e) => {
  S.micOn = e.target.checked;
  S.micBlocked = false;
  if (S.micOn && !S.recog) S.recog = initMic();
  if (S.micOn && !S.recog) {
    toast('Voice input needs Chrome — use text.'); e.target.checked = false; S.micOn = false; return;
  }
  if (!S.micOn) {
    clearTimeout(S.micArmTimer);
    try { if (S.recogActive) S.recog.abort(); } catch {}
    return;
  }
  S.voiceAnswerSubmitted = false;
  // If a question is already pending, keep listening until it is answered.
  // Otherwise preserve the existing one-shot voice-entry behavior.
  armMic({ requirePending: !!(isGuide && S.pending) });
});
$('#redactToggle').addEventListener('change', async (e) => { S.redact = e.target.checked; await api(`/api/room/${CODE}/redact`, { on: S.redact }); toast(S.redact ? 'Redaction on' : 'Redaction off'); if ($('#queue')) renderQueue(); });
$('#emailShareBtn').addEventListener('click', () => {
  const joinLink = `${location.origin}/room.html?code=${CODE}&role=student`;
  const subject = S.curriculum
    ? `Mentaur — workflow curriculum: ${S.curriculum.title}`
    : `Mentaur — session in room ${CODE}`;
  const lines = [];
  if (S.curriculum) {
    lines.push(S.curriculum.summary, '');
    lines.push('Lessons:');
    S.curriculum.lessons.slice(0, 8).forEach((L) => {
      lines.push(`${L.n}. ${L.title} — ${L.did}${L.guardrail ? ` (guardrail: ${L.guardrail})` : ''}`);
    });
    lines.push('');
  } else {
    lines.push(`Sharing a live Mentaur apprentice session (room ${CODE}).`, '');
  }
  lines.push(`Open it / practice it yourself: ${joinLink}`);
  lines.push('');
  lines.push('(If you downloaded the PDF from this session, attach it before sending — email links can’t attach files automatically.)');
  const body = lines.join('\n').slice(0, 1800);
  location.href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
});
$('#exportPdfBtn').addEventListener('click', () => {
  const stamp = new Date().toISOString().slice(0, 10);
  $('#printHeader').textContent = `Conversation transcript — Room ${CODE} — ${isGuide ? 'Guide' : 'Student'} — ${stamp}`;
  const prevTitle = document.title;
  document.title = `Mentaur — ${CODE} — ${stamp}`;
  const restore = () => { document.title = prevTitle; window.removeEventListener('afterprint', restore); };
  window.addEventListener('afterprint', restore);
  window.print();
});
$('#offRecBtn').addEventListener('click', () => { S.offRecord = !S.offRecord; $('#offRecBtn').classList.toggle('on', S.offRecord); toast(S.offRecord ? 'Next answer off the record' : 'Back on the record'); });

boot();
