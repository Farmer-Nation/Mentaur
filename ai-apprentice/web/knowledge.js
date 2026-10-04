const $ = (s) => document.querySelector(s);
let CFG = null; let ME = null; let lastAnswer = '';

async function request(path, body) {
  const r = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {}; try { data = await r.json(); } catch {}
  if (r.status === 401) { location.href = '/'; throw new Error('Sign in required.'); }
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
function toast(text) { const t = $('#toast'); t.textContent = text; t.className = 'toast show'; clearTimeout(t._tm); t._tm = setTimeout(() => t.className = 'toast', 2600); }
function fmtDate(value) { if (!value) return 'Active session'; return new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); }
function addMessage(role, text, sources = []) {
  const log = $('#kbMessages'); log.querySelector('.kb-empty')?.remove();
  const msg = document.createElement('div'); msg.className = `kb-msg ${role}`;
  const bubble = document.createElement('div'); bubble.className = 'kb-bubble'; bubble.textContent = text; msg.appendChild(bubble);
  if (role === 'assistant' && text) {
    const actions = document.createElement('div'); actions.className = 'kb-msg-actions';
    const listen = document.createElement('button'); listen.type = 'button'; listen.className = 'btn ghost kb-listen'; listen.textContent = '▶ Listen';
    listen.onclick = () => speak(text); actions.appendChild(listen); msg.appendChild(actions);
  }
  if (sources?.length) {
    const source = document.createElement('div'); source.className = 'kb-sources';
    const unique = [...new Map(sources.map((s) => [`${s.teacher}|${s.session}|${s.title}`, s])).values()].slice(0, 5);
    source.textContent = `Sources: ${unique.map((s) => `${s.teacher || 'Teacher'} · ${s.title || s.session || 'session'}`).join(' • ')}`;
    msg.appendChild(source);
  }
  log.appendChild(msg); log.scrollTop = log.scrollHeight;
}

async function ask() {
  const box = $('#kbQuestion'); const question = box.value.trim(); if (!question) return;
  addMessage('user', question); box.value = '';
  $('#kbAsk').disabled = true; $('#kbAsk').textContent = 'Thinking…';
  try {
    const out = await request('/api/knowledge/ask', { question });
    lastAnswer = out.answer || '';
    addMessage('assistant', lastAnswer, out.sources || []);
  } catch (err) { addMessage('assistant', err.message); }
  finally { $('#kbAsk').disabled = false; $('#kbAsk').textContent = 'Ask'; }
}

async function speak(text) {
  if (!text) return;
  if (CFG?.voiceMode?.startsWith('elevenlabs')) {
    try {
      const r = await fetch('/api/voice/tts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
      if (r.ok && r.headers.get('content-type')?.includes('audio')) {
        const url = URL.createObjectURL(await r.blob()); const a = new Audio(url); a.onended = () => URL.revokeObjectURL(url); await a.play(); return;
      }
    } catch { /* browser voice fallback */ }
  }
  if ('speechSynthesis' in window) { speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); speechSynthesis.speak(u); }
}

function setupMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const btn = $('#kbMic');
  if (!SR) { btn.disabled = true; btn.title = 'Voice input is not supported in this browser'; return; }
  const rec = new SR(); rec.lang = 'en-US'; rec.interimResults = true; rec.continuous = false;
  let finalText = '';
  rec.onstart = () => { btn.classList.add('active'); finalText = ''; toast('Listening…'); };
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const part = e.results[i][0].transcript.trim();
      if (e.results[i].isFinal) finalText = `${finalText} ${part}`.trim(); else interim += ` ${part}`;
    }
    $('#kbQuestion').value = `${finalText} ${interim}`.trim();
  };
  rec.onend = () => { btn.classList.remove('active'); if ($('#kbQuestion').value.trim()) ask(); };
  rec.onerror = () => { btn.classList.remove('active'); toast('Microphone input was unavailable.'); };
  btn.onclick = () => { try { rec.start(); } catch {} };
}

async function renderTeacher() {
  $('#teacherKb').classList.remove('hidden');
  const { sessions } = await request('/api/knowledge/teacher');
  const wrap = $('#teacherSessions'); wrap.innerHTML = '';
  if (!sessions.length) { wrap.innerHTML = '<div class="kb-empty-card">No saved sessions yet. Start a teaching session from the dashboard.</div>'; return; }
  for (const s of sessions) {
    const card = document.createElement('article'); card.className = 'kb-session-card';
    const title = document.createElement('h3'); title.textContent = s.title || `Session ${s.room_code}`;
    const meta = document.createElement('div'); meta.className = 'kb-session-meta'; meta.textContent = `${s.status === 'complete' ? 'Complete' : 'Active'} · ${fmtDate(s.started_at)} · room ${s.room_code}`;
    const summary = document.createElement('p'); summary.textContent = s.summary || 'Knowledge is being captured from this session.';
    card.append(title, meta, summary); wrap.appendChild(card);
  }
}

async function boot() {
  [CFG, ME] = await Promise.all([request('/api/config'), request('/api/auth/me')]);
  if (!ME.authenticated) return location.href = '/';
  const u = ME.user; $('#kbRole').textContent = `${u.role} · ${u.email}`;
  if (u.role === 'learner') {
    $('#kbTitle').textContent = 'Your combined teacher knowledge';
    $('#kbIntro').textContent = 'This chatbot searches only sessions you joined, across every teacher you have learned from, then asks Claude to answer from that evidence.';
    $('#learnerKb').classList.remove('hidden');
    $('#kbMode').textContent = `${CFG.knowledgeMode} · ${CFG.reasoningMode}`;
    setupMic();
  } else {
    $('#kbTitle').textContent = 'Your teaching knowledge';
    $('#kbIntro').textContent = 'Mentaur saves structured session knowledge to Supabase so learners who attended your sessions can query it later.';
    await renderTeacher();
  }
}

$('#kbAsk').addEventListener('click', ask);
$('#kbQuestion').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(); } });
$('#kbLogout').addEventListener('click', async () => { await request('/api/auth/logout', {}); location.href = '/'; });
boot().catch((err) => { toast(err.message); });
