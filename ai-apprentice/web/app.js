// The AI Apprentice — room client (role-aware).
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
  speaking: false, micOn: false, recog: null, curriculum: null, workMap: [],
  teach: null, prevFrame: null, shareStream: null,
};

/* ---------- clock ---------- */
setInterval(() => { $('#sessionClock').textContent = fmt(Date.now() - S.started); }, 500);
function fmt(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); }

/* ---------- voice ---------- */
async function speak(text) {
  if (!$('#ttsToggle').checked) return;
  if (isGuide) { await api(`/api/room/${CODE}/speaking`, { on: true }); S.speaking = true; }
  setOrb('speaking'); setStatus('Speaking…');
  const done = async () => { if (isGuide) { await api(`/api/room/${CODE}/speaking`, { on: false }); S.speaking = false; } setOrb('listening'); setStatus(idleText()); };
  if (S.config && S.config.voiceMode !== 'mock') {
    try { const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.headers.get('content-type')?.includes('audio')) { const a = new Audio(URL.createObjectURL(await r.blob())); a.onended = done; a.play(); return; } } catch {}
  }
  if (!('speechSynthesis' in window)) return setTimeout(done, 500 + text.length * 16);
  try { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text.replace(/<[^>]+>/g, '')); u.rate = 1.02; u.onend = done; u.onerror = done; speechSynthesis.speak(u); } catch { done(); }
}
function initMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR(); r.lang = 'en-US'; r.interimResults = false;
  r.onresult = (e) => { $('#replyBox').value = e.results[0][0].transcript; submitReply(); };
  return r;
}

/* ---------- orb/status/toast ---------- */
function setOrb(m) { $('#orb').className = 'orb ' + m; }
function setStatus(t) { $('#statusline').textContent = t; }
function idleText() {
  if (S.phase === 'practice') return 'Coaching — I’ll step in before a mistake';
  if (isGuide) return S.pending ? 'Waiting for your answer…' : 'Listening — I’ll ask only at a pause';
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
  if (role !== 'event') m.appendChild(el('div', 'lbl', opts.lbl || (role === 'agent' ? 'Apprentice' : role === 'guide' ? 'Guide' : role === 'student' ? 'Student' : 'Session')));
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
    }
  };
}
function onEvent(d) {
  addMsg('event', '▸ ' + fmt(d.event.t) + '  ' + d.event.text);
  if (d.invoices) { S.invoices = d.invoices; if (S.phase === 'capture') renderQueue(); if (S.selected) renderEditor(); }
}
function onAsk(d) {
  S.pending = d;
  if (isGuide) { addMsg('agent', d.question, { guardrail: d.guardrail }); speak(d.question); setStatus('Waiting for your answer…'); if (S.micOn && S.recog) { try { S.recog.start(); } catch {} } }
  else { addMsg('agent', d.question, { guardrail: d.guardrail, lbl: 'Apprentice → Guide' }); }
}
function onAck(d) { if (isGuide) addMsg('agent', d.guardrail ? 'Got it — I’ll treat that as a guardrail.' : 'Thanks, that’s the reasoning I needed.'); S.pending = null; renderCoverage(d.coverage); }
function onChat(msg) {
  if (msg.from === 'guide') addMsg('guide', msg.text);
  else if (msg.from === 'student') { addMsg('student', msg.text); if (isGuide) { toast('Student asked a question'); } }
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
  $('#roleSub').textContent = isGuide ? 'You are the Guide — do the task, I’ll learn it' : 'You are the Student — follow along and ask';
  $('#agentName').textContent = 'Apprentice';
  S.recog = initMic();

  const view = await api(`/api/room/${CODE}`);
  if (view.error) { $('#surface').innerHTML = `<div class="intro"><h3>Room not found</h3><p>The code <b>${CODE}</b> isn’t active. <a href="/">Go back</a> and check it.</p></div>`; return; }
  S.invoices = view.invoices; S.phase = view.phase; S.curriculum = view.curriculum; S.workMap = view.workMap;
  renderPresence(view.presence);
  connect();

  if (S.phase === 'curriculum' || S.phase === 'practice') renderCurriculum();
  else if (isGuide) renderGuideCapture();
  else renderStudentLive();
  setOrb('listening'); setStatus(idleText());
  // replay recent transcript for late joiners
  view.chat.forEach(onChat);
  renderSuggestions(view.suggestions);
}

/* ============================================================
   GUIDE — live capture
   ============================================================ */
function renderGuideCapture() {
  S.phase = 'capture'; setPhase('capture');
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Live session</h2><div class="lead">Do the task the way you really would. I’ll stay quiet while you work and ask <b>why</b> only at a pause. A student is following along.</div></div><span class="pill" id="progressPill">0 / 3</span>`));
  const erp = el('div', 'erp');
  erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Sandbox ERP · Accounts Payable <span class="tag">month-end close</span>`));
  const q = el('div', 'queue'); q.id = 'queue'; erp.appendChild(q); s.appendChild(erp);
  s.appendChild(Object.assign(el('div'), { id: 'editorMount' }));
  const sb = el('div', 'sharebar');
  sb.innerHTML = `<button class="btn ghost" id="shareBtn">▣ Share real screen</button><video id="shareVid" class="hidden" muted autoplay playsinline></video><span class="hint">Optional: share your real screen and (in vision mode) a model turns frames into events the student sees. Otherwise this sandbox is the task.</span>`;
  s.appendChild(sb);
  $('#shareBtn').onclick = shareScreen;
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
  $('#progressPill') && ($('#progressPill').textContent = `${done} / 3`);
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

/* screen share + vision */
async function shareScreen() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    S.shareStream = stream; const v = $('#shareVid'); v.classList.remove('hidden'); v.srcObject = stream; $('#shareBtn').textContent = '▣ Sharing';
    startFrameLoop(v);
    stream.getVideoTracks()[0].addEventListener('ended', () => { v.classList.add('hidden'); $('#shareBtn').textContent = '▣ Share real screen'; });
  } catch { toast('Screen share cancelled.'); }
}
function startFrameLoop(video) {
  const canvas = document.createElement('canvas');
  const grab = () => {
    if (!S.shareStream || !S.shareStream.active) return;
    const w = 960, h = Math.round((video.videoHeight / video.videoWidth) * 960) || 540;
    canvas.width = w; canvas.height = h; canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    const next = canvas.toDataURL('image/jpeg', 0.6);
    if (S.config.visionMode !== 'mock') api('/api/vision', { code: CODE, prev: S.prevFrame, next });
    else api(`/api/room/${CODE}/frame`, { frame: next }); // relay to student even in mock
    S.prevFrame = next; setTimeout(grab, 1800);
  };
  setTimeout(grab, 1000);
}

/* ============================================================
   STUDENT — live mirror
   ============================================================ */
function renderStudentLive() {
  S.phase = 'capture'; setPhase('capture');
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Watching the guide</h2><div class="lead">This updates live as the guide works. Ask anything by voice or text — or tap a suggested question on the right.</div></div><span class="pill live">● live</span>`));
  const frame = el('div', 'mirror'); frame.id = 'mirror';
  frame.innerHTML = `<img id="mirrorImg" class="hidden" alt="guide screen"><div class="mirror-empty" id="mirrorEmpty">The guide’s screen appears here when they share it.</div>`;
  s.appendChild(frame);
  const erp = el('div', 'erp'); erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Guide’s workspace (mirror) <span class="tag">read-only</span>`));
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
  addMsg('agent', 'All three are processed. Ready for a quick debrief to close the gaps?');
  speak('All three are processed. Ready for a quick debrief?');
  const bar = el('div'); bar.style.marginTop = '16px'; bar.innerHTML = `<button class="btn primary" id="startDebrief">Start debrief →</button>`;
  $('#surface').appendChild(bar);
  $('#startDebrief').onclick = async () => { $('#startDebrief').remove(); await api(`/api/room/${CODE}/debrief`, {}); };
}
function startTeachback(steps) {
  S.phase = 'teachback';
  const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', "<div><h2>Teach-back</h2><div class='lead'>Here’s your process in my words. Confirm it and I’ll build the curriculum for the student.</div></div>"));
  const lines = steps.map((st, i) => `${i + 1}. ${st.title}: ${st.decision} — because “${st.reason}”. Guardrail: ${st.guardrail}`);
  const card = el('div', 'intro');
  card.innerHTML = `<h3>This is how I understand it</h3><ol>${lines.map((l) => `<li>${redact(l)}</li>`).join('')}</ol><button class="btn primary" id="confirmTB">✓ Yes — build the curriculum</button>`;
  s.appendChild(card);
  addMsg('agent', 'I’ll explain it back — confirm on the left.');
  speak('Here’s how I understand your process. ' + lines.join('. '));
  $('#confirmTB').onclick = async () => { addMsg('guide', 'Yes, that’s how it works.'); await api(`/api/room/${CODE}/confirm`, {}); };
}
function waitForCurriculum() { const s = $('#surface'); s.innerHTML = `<div class="intro"><h3>Building your curriculum…</h3><p>The guide is confirming the process. This page will update automatically.</p></div>`; }

/* ---------- curriculum (both) ---------- */
function onCurriculum(d) { S.curriculum = d.curriculum; S.workMap = d.workMap; renderCurriculum(); }
function onPhase(phase) { S.phase = phase; if (phase === 'curriculum') { if (!S.curriculum) api(`/api/room/${CODE}/curriculum`).then((d) => { S.curriculum = d.curriculum; S.workMap = d.workMap; renderCurriculum(); }); } if (phase === 'practice' && !isGuide) {/* guide started practice elsewhere */} }
async function renderCurriculum() {
  setPhase('curriculum');
  if (!S.curriculum) { const d = await api(`/api/room/${CODE}/curriculum`); S.curriculum = d.curriculum; S.workMap = d.workMap; }
  const c = S.curriculum; const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>${c.title}</h2><div class="lead">${redact(c.summary)}</div></div><a class="btn" href="/api/room/${CODE}/export" download>⤓ Agent-ready JSON</a>`));
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
  if (!isGuide) cta.innerHTML = `<button class="btn primary big" id="startPractice">Practice this now →</button>`;
  else cta.innerHTML = `<div class="hint" style="color:var(--muted)">The student can now practice. You’ll see their result here.</div>`;
  s.appendChild(cta);
  $('#suggestions').style.display = 'none'; $('#coverageBox').style.display = 'none';
  if (!isGuide) $('#startPractice').onclick = startPractice;
  addMsg('agent', isGuide ? 'Curriculum is ready and shared with the student.' : 'Curriculum ready. Practice when you like — I’ll coach you as your guide would.');
}

/* ---------- practice (student) ---------- */
async function startPractice() {
  const p = await api(`/api/room/${CODE}/practice`, { studentId: 's' });
  S.teach = p; S.phase = 'practice'; setPhase('practice');
  const inv = p.inv; const s = $('#surface'); s.innerHTML = '';
  s.appendChild(el('div', 'surface-head', `<div><h2>Practice</h2><div class='lead'>A case your guide never showed you. I’ll step in <b>before</b> a guardrail is broken, using their reasoning.</div></div><span class="pill">new case</span>`));
  const erp = el('div', 'erp'); erp.appendChild(el('div', 'erp-bar', `<span class="dot"></span> Your workspace <span class="tag">coached</span>`)); s.appendChild(erp);
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
  card.innerHTML = `<h3>What you’ve mastered — and what to practice</h3>${d.score.map((x) => `<div class="scorerow"><span class="ic ${x.ok ? 'ok' : 'miss'}">${x.ok ? '✓' : '!'}</span><div class="t"><b>${x.label}</b><div>${x.note}</div></div></div>`).join('')}<div style="margin-top:16px;display:flex;gap:10px"><button class="btn" id="againBtn">↺ Try again</button><button class="btn ghost" id="backCur">← Curriculum</button></div>`;
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
$('#replyBox').addEventListener('input', () => reportActivity(true));
$('#micToggle').addEventListener('change', (e) => { S.micOn = e.target.checked; if (S.micOn && !S.recog) S.recog = initMic(); if (S.micOn && !S.recog) { toast('Voice input needs Chrome — use text.'); e.target.checked = false; S.micOn = false; return; } if (S.micOn && S.recog) { try { S.recog.start(); } catch {} } });
$('#redactToggle').addEventListener('change', async (e) => { S.redact = e.target.checked; await api(`/api/room/${CODE}/redact`, { on: S.redact }); toast(S.redact ? 'Redaction on' : 'Redaction off'); if ($('#queue')) renderQueue(); });
$('#offRecBtn').addEventListener('click', () => { S.offRecord = !S.offRecord; $('#offRecBtn').classList.toggle('on', S.offRecord); toast(S.offRecord ? 'Next answer off the record' : 'Back on the record'); });

boot();
