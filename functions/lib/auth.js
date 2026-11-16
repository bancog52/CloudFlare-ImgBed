const COOKIE_NAME = 'imghub_session';
const SESSION_TTL_SEC = 7 * 24 * 3600;

export function getAdminPassword(env) {
  return (env.ADMIN_PASSWORD || env.BASIC_PASS || '').trim();
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);
  if (bufA.length !== bufB.length) return false;
  let diff = 0;
  for (let i = 0; i < bufA.length; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

async function getHmacKey(env) {
  const secret = env.SESSION_SECRET || `${getAdminPassword(env)}:imghub-hmac-salt-v1`;
  const data = new TextEncoder().encode(secret);
  return crypto.subtle.importKey('raw', data, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function createSessionCookie(env, request) {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const payload = String(exp);
  const key = await getHmacKey(env);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
  const token = `${payload}.${toBase64Url(sig)}`;
  const isHttps = new URL(request.url).protocol === 'https:';
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SEC}; SameSite=Lax${isHttps ? '; Secure' : ''}`;
}

export function clearSessionCookie(request) {
  const isHttps = new URL(request.url).protocol === 'https:';
  return `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${isHttps ? '; Secure' : ''}`;
}

function parseCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return part.slice(idx + 1).trim();
    }
  }
  return '';
}

export async function verifySession(request, env) {
  const password = getAdminPassword(env);
  if (!password) return true;

  const token = parseCookie(request, COOKIE_NAME);
  const dot = token.indexOf('.');
  if (dot <= 0) return false;

  const payload = token.slice(0, dot);
  const exp = Number(payload);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;

  try {
    const sig = fromBase64Url(token.slice(dot + 1));
    const key = await getHmacKey(env);
    return await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode(payload));
  } catch {
    return false;
  }
}

export async function isAuthorized(request, env) {
  const apiToken = (env.API_TOKEN || '').trim();
  const authHeader = request.headers.get('Authorization') || '';
  if (apiToken && authHeader.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (timingSafeEqual(bearer, apiToken)) return true;
  }
  return verifySession(request, env);
}

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

