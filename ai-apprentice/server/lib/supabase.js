// Minimal Supabase REST/Auth adapter.
// Keeps the service-role key server-only and uses HttpOnly cookies for browser sessions,
// so live EventSource connections can be authenticated without leaking JWTs in URLs.

const URL = String(process.env.SUPABASE_URL || '').replace(/\/$/, '');
const ANON_KEY = process.env.SUPABASE_ANON_KEY || '';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';

export const supabaseMode = URL && ANON_KEY ? 'supabase' : 'off';
export const hasServiceRole = !!SERVICE_KEY;

function cookie(name, value, { maxAge } = {}) {
  const attrs = [`${name}=${encodeURIComponent(value || '')}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (COOKIE_SECURE) attrs.push('Secure');
  if (Number.isFinite(maxAge)) attrs.push(`Max-Age=${Math.max(0, Math.floor(maxAge))}`);
  return attrs.join('; ');
}

export function parseCookies(req) {
  const out = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const i = item.indexOf('=');
    if (i < 0) continue;
    const key = item.slice(0, i).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(item.slice(i + 1).trim()); } catch { out[key] = item.slice(i + 1).trim(); }
  }
  return out;
}

function setSessionCookies(res, session) {
  if (!session?.access_token || !session?.refresh_token) return;
  const accessMax = Number(session.expires_in) || 3600;
  res.setHeader('Set-Cookie', [
    cookie('mentaur_access', session.access_token, { maxAge: accessMax }),
    cookie('mentaur_refresh', session.refresh_token, { maxAge: 60 * 60 * 24 * 30 }),
  ]);
}

export function clearSessionCookies(res) {
  res.setHeader('Set-Cookie', [
    cookie('mentaur_access', '', { maxAge: 0 }),
    cookie('mentaur_refresh', '', { maxAge: 0 }),
  ]);
}

async function request(path, { method = 'GET', body, token, service = false, headers = {} } = {}) {
  if (!URL || !ANON_KEY) throw new Error('Supabase is not configured. Set SUPABASE_URL and SUPABASE_ANON_KEY.');
  const key = service ? SERVICE_KEY : ANON_KEY;
  if (service && !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this server operation.');
  const r = await fetch(`${URL}${path}`, {
    method,
    headers: {
      apikey: key || ANON_KEY,
      ...(token || service ? { authorization: `Bearer ${token || key}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const raw = await r.text();
  let data = null;
  if (raw) { try { data = JSON.parse(raw); } catch { data = raw; } }
  if (!r.ok) {
    const message = data?.msg || data?.message || data?.error_description || data?.error || raw || `Supabase request failed (${r.status})`;
    const err = new Error(typeof message === 'string' ? message : `Supabase request failed (${r.status})`);
    err.status = r.status; err.data = data; throw err;
  }
  return data;
}

export async function signUp({ email, password, fullName, role }) {
  if (!hasServiceRole) {
    throw new Error('SUPABASE_SERVICE_ROLE_KEY is required to create accounts without email verification.');
  }

  // Create the account through the server-only Admin API and mark the email as
  // confirmed immediately. This keeps the service-role key off the browser while
  // making sign-up independent of the project's "Confirm email" toggle.
  await request('/auth/v1/admin/users', {
    method: 'POST',
    service: true,
    body: {
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName, role },
    },
  });

  // Admin user creation does not return a browser session, so sign in once to
  // obtain the normal access/refresh tokens used by the HttpOnly cookie flow.
  return signIn({ email, password });
}

export async function signIn({ email, password }) {
  return request('/auth/v1/token?grant_type=password', { method: 'POST', body: { email, password } });
}

async function refresh(refreshToken) {
  return request('/auth/v1/token?grant_type=refresh_token', { method: 'POST', body: { refresh_token: refreshToken } });
}

async function authUser(accessToken) {
  return request('/auth/v1/user', { token: accessToken });
}

export async function signOut(accessToken) {
  if (!accessToken) return;
  try { await request('/auth/v1/logout', { method: 'POST', token: accessToken }); } catch { /* local logout still succeeds */ }
}

export async function db(path, { method = 'GET', body, token, service = false, prefer } = {}) {
  return request(`/rest/v1/${path}`, {
    method, body, token, service,
    headers: prefer ? { Prefer: prefer } : {},
  });
}

async function getProfile(userId, accessToken) {
  const rows = await db(`profiles?id=eq.${encodeURIComponent(userId)}&select=id,full_name,role,created_at`, {
    token: hasServiceRole ? undefined : accessToken,
    service: hasServiceRole,
  });
  return Array.isArray(rows) ? rows[0] || null : null;
}

export async function getAuthContext(req, res) {
  if (supabaseMode === 'off') return null;
  const cookies = parseCookies(req);
  let accessToken = cookies.mentaur_access || '';
  let refreshToken = cookies.mentaur_refresh || '';
  let user = null;

  if (accessToken) {
    try { user = await authUser(accessToken); } catch { user = null; }
  }
  if (!user && refreshToken) {
    try {
      const session = await refresh(refreshToken);
      accessToken = session.access_token;
      refreshToken = session.refresh_token;
      setSessionCookies(res, session);
      user = await authUser(accessToken);
    } catch {
      clearSessionCookies(res);
      return null;
    }
  }
  if (!user) return null;
  const profile = await getProfile(user.id, accessToken).catch(() => null);
  if (!profile) return null;
  return { user, profile, accessToken, refreshToken };
}

export function applySession(res, session) { setSessionCookies(res, session); }

export async function adminDb(path, opts = {}) {
  return db(path, { ...opts, service: true });
}
