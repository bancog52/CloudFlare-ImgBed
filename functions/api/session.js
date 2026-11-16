import { getAdminPassword, verifySession, jsonResponse } from '../lib/auth.js';

export async function onRequestGet({ request, env }) {
  const passwordRequired = !!getAdminPassword(env);
  const authenticated = await verifySession(request, env);
  return jsonResponse({ authenticated, passwordRequired });
}
