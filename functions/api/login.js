import {
  getAdminPassword,
  timingSafeEqual,
  createSessionCookie,
  clearSessionCookie,
  jsonResponse,
} from '../lib/auth.js';

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
