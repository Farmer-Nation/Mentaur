const $ = (s) => document.querySelector(s);

async function request(path, body) {
  const r = await fetch(path, body === undefined ? {} : {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  let data = {}; try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

function busy(button, on, label) {
  if (!button) return;
  button.disabled = on;
  const span = button.querySelector('span');
  if (span && label) span.textContent = label;
}

async function render() {
  const [cfg, me] = await Promise.all([request('/api/config'), request('/api/auth/me')]);
  $('#modeFoot').textContent = `${cfg.supabaseMode} auth · ${cfg.knowledgeMode} KB · ${cfg.reasoningMode} reasoning · ${cfg.voiceMode} voice`;

  if (!me.authenticated) {
    $('#authView').classList.remove('hidden');
    $('#dashboardView').classList.add('hidden');
    return;
  }

  $('#authView').classList.add('hidden');
  $('#dashboardView').classList.remove('hidden');
  const u = me.user;
  $('#dashRole').textContent = u.role === 'teacher' ? 'Teacher account' : 'Learner account';
  $('#dashGreeting').textContent = u.fullName ? `Welcome, ${u.fullName}` : 'Welcome back';
  $('#dashCopy').textContent = u.role === 'teacher'
    ? 'Create a room, share your screen, and turn your working knowledge into a reusable private library.'
    : 'Join a teacher live, then query the combined knowledge from every teacher session you have attended.';
  $('#teacherDash').classList.toggle('hidden', u.role !== 'teacher');
  $('#learnerDash').classList.toggle('hidden', u.role !== 'learner');
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const btn = e.submitter; const status = $('#loginStatus');
  status.textContent = ''; busy(btn, true, 'Signing in…');
  try {
    await request('/api/auth/login', { email: $('#loginEmail').value, password: $('#loginPassword').value });
    await render();
  } catch (err) { status.textContent = err.message; }
  finally { busy(btn, false, 'Sign in'); }
});

$('#signupForm').addEventListener('submit', async (e) => {
  e.preventDefault(); const btn = e.submitter; const status = $('#signupStatus');
  status.textContent = ''; busy(btn, true, 'Creating…');
  const role = new FormData(e.currentTarget).get('role');
  try {
    await request('/api/auth/signup', {
      fullName: $('#signupName').value, email: $('#signupEmail').value,
      password: $('#signupPassword').value, role,
    });
    await render();
  } catch (err) { status.textContent = err.message; }
  finally { busy(btn, false, 'Create account'); }
});

$('#startTeacher').addEventListener('click', async (e) => {
  const btn = e.currentTarget; busy(btn, true, 'Opening room…');
  try {
    const { code } = await request('/api/room', {});
    location.href = `/room.html?code=${encodeURIComponent(code)}`;
  } catch (err) {
    alert(err.message); busy(btn, false, 'Start session');
  }
});

async function joinRoom() {
  const input = $('#joinCode'); const code = input.value.trim().toUpperCase(); const status = $('#joinStatus');
  status.textContent = '';
  if (!/^[A-Z0-9]{5}$/.test(code)) { input.classList.add('shake'); return; }
  const btn = $('#joinLearner'); busy(btn, true, 'Joining…');
  try {
    await request(`/api/room/${code}/join`, {});
    location.href = `/room.html?code=${encodeURIComponent(code)}`;
  } catch (err) { status.textContent = err.message; busy(btn, false, 'Join room'); }
}
$('#joinLearner').addEventListener('click', joinRoom);
$('#joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinRoom(); });
$('#joinCode').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); e.target.classList.remove('shake');
});

$('#logoutBtn').addEventListener('click', async () => { await request('/api/auth/logout', {}); location.href = '/'; });

render().catch((err) => {
  $('#authView').classList.remove('hidden');
  $('#loginStatus').textContent = err.message;
});
