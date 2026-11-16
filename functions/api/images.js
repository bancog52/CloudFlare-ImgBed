import { isAuthorized, jsonResponse } from '../lib/auth.js';

export async function onRequestGet({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get('page'), 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get('limit'), 10) || 30));
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
      COALESCE(SUM(CASE WHEN primary_channel = 'r2' THEN size_bytes ELSE 0 END), 0) AS r2_bytes,
      COALESCE(SUM(CASE WHEN backup_status = 'ok' THEN original_size ELSE 0 END), 0) AS tg_bytes
    FROM images`
  );

  const [listRes, countRes, statsRes] = await db.batch([listStmt, countStmt, statsStmt]);

  return jsonResponse({
    items: listRes.results || [],
    total: countRes.results?.[0]?.total || 0,
    page,
    limit,
    stats: statsRes.results?.[0] || { total_count: 0, r2_bytes: 0, tg_bytes: 0 },
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
    .prepare('SELECT id, primary_channel FROM images WHERE id = ?')
    .bind(id)
    .first();

  if (!row) return jsonResponse({ error: 'Not found' }, 404);

  if (row.primary_channel === 'r2' && env.img_r2) {
    await env.img_r2.delete(id);
  }

  await env.img_bed_db.prepare('DELETE FROM images WHERE id = ?').bind(id).run();
  return jsonResponse({ ok: true, id });
}

