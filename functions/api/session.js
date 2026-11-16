import { getAdminPassword, verifySession, jsonResponse } from '../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const passwordRequired = !!getAdminPassword(env);
  const authenticated = await verifySession(request, env);
  const turnstileSiteKey = (env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY)
    ? env.TURNSTILE_SITE_KEY.trim()
    : '';
  return jsonResponse({ authenticated, passwordRequired, turnstileSiteKey });
}

