import { isAuthorized, jsonResponse } from '../lib/auth.js';

export async function onRequestGet({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 100));
  const offset = (page - 1) * limit;
  const q = (url.searchParams.get('q') || '').trim();
  const folder = (url.searchParams.get('folder') || '').trim().replace(/^\/+|\/+$/g, '');

  const conditions = [];
  const params = [];
  if (q) {
    conditions.push('(id LIKE ? OR file_name LIKE ? OR original_name LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (folder) {
    conditions.push('folder = ?');
    params.push(folder);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const db = env.img_bed_db;

  const listStmt = db
    .prepare(`SELECT * FROM images ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
    .bind(...params, limit, offset);
  const countStmt = db
    .prepare(`SELECT COUNT(*) AS total FROM images ${where}`)
    .bind(...params);
  const statsStmt = db.prepare(
    `SELECT
      COUNT(*) AS total_count,
      COALESCE(SUM(size_bytes), 0) AS r2_bytes
    FROM images`
  );

  const [listRes, countRes, statsRes] = await db.batch([listStmt, countStmt, statsStmt]);

  return jsonResponse({
    items: listRes.results || [],
    total: countRes.results?.[0]?.total || 0,
    page,
    limit,
    stats: statsRes.results?.[0] || { total_count: 0, r2_bytes: 0 },
  });
}

export async function onRequestDelete({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  if (!id) return jsonResponse({ error: 'Missing id' }, 400);

  const row = await env.img_bed_db
    .prepare('SELECT id FROM images WHERE id = ?')
    .bind(id)
    .first();

  if (!row) return jsonResponse({ error: 'Not found' }, 404);

  if (env.img_r2) {
    await env.img_r2.delete(id);
  }

  await env.img_bed_db.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
  return jsonResponse({ ok: true, id });
}
