import {
  getAdminPassword,
  timingSafeEqual,
  createSessionCookie,
  clearSessionCookie,
  jsonResponse,
} from '../lib/auth.js';

async function verifyTurnstile(secret, token, remoteIp) {
  if (!token) return false;
  const form = new URLSearchParams();
  form.append('secret', secret);
  form.append('response', token);
  if (remoteIp) form.append('remoteip', remoteIp);

  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) return false;
  const data = await res.json();
  return !!data.success;
}

export async function onRequestPost({ request, env }) {
  const expected = getAdminPassword(env);
  if (!expected) {
    return jsonResponse({ ok: true }, 200, {
      'Set-Cookie': await createSessionCookie(env, request),
    });
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const turnstileSecret = (env.TURNSTILE_SECRET_KEY || '').trim();
  if (turnstileSecret) {
    const ip = request.headers.get('CF-Connecting-IP') || '';
    const ok = await verifyTurnstile(turnstileSecret, body.turnstileToken, ip);
    if (!ok) {
      return jsonResponse({ error: '人机验证失败，请重试' }, 403);
    }
  }

  if (!timingSafeEqual(String(body.password || ''), expected)) {
    return jsonResponse({ error: '密码错误' }, 401);
  }

  return jsonResponse({ ok: true }, 200, {
    'Set-Cookie': await createSessionCookie(env, request),
  });
}

export async function onRequestDelete({ request }) {
  return jsonResponse({ ok: true }, 200, {
    'Set-Cookie': clearSessionCookie(request),
  });
}

