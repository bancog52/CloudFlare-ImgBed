import { getTgConfig, resolveTgFileUrl, createChunkedStream } from '../lib/telegram.js';

function buildHeaders(mimeType, fileName, download = false) {
  const headers = new Headers();
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  const disp = download ? 'attachment' : 'inline';
  const safeName = encodeURIComponent(fileName || 'image');
  headers.set('Content-Disposition', `${disp}; filename*=UTF-8''${safeName}`);
  return headers;
}

async function serveFromTelegram(env, row, downloadOriginal) {
  const cfg = getTgConfig(env);
  if (!cfg) return new Response('Telegram is not configured', { status: 500 });

  const mime = row.original_mime || row.mime_type;
  const name = row.original_name || row.file_name;

  if (row.tg_chunks) {
    const chunks = JSON.parse(row.tg_chunks);
    const stream = createChunkedStream(cfg, chunks);
    const headers = buildHeaders(mime, name, downloadOriginal);
    if (row.original_size) headers.set('Content-Length', String(row.original_size));
    return new Response(stream, { status: 200, headers });
  }

  if (!row.tg_file_id) {
    return new Response('Telegram backup not found', { status: 404 });
  }

  const fileUrl = await resolveTgFileUrl(cfg, row.tg_file_id);
  if (!fileUrl) return new Response('Failed to resolve Telegram file path', { status: 502 });

  const upstream = await fetch(fileUrl);
  if (!upstream.ok) return new Response('Failed to fetch Telegram file', { status: upstream.status });

  const headers = buildHeaders(mime, name, downloadOriginal);
  const len = upstream.headers.get('Content-Length');
  if (len) headers.set('Content-Length', len);

  return new Response(upstream.body, { status: 200, headers });
}

export async function onRequestGet({ request, env, params }) {
  const pathParts = Array.isArray(params.path) ? params.path : [params.path];
  const id = pathParts.filter(Boolean).join('/');
  if (!id) return new Response('Not Found', { status: 404 });

  const row = await env.img_bed_db
    .prepare('SELECT * FROM images WHERE id = ?')
    .bind(id)
    .first();

  if (!row) return new Response('Not Found', { status: 404 });

  const url = new URL(request.url);
  const wantOriginal = url.searchParams.get('original') === '1';

  if (wantOriginal && (row.tg_file_id || row.tg_chunks)) {
    return serveFromTelegram(env, row, true);
  }

  if (row.primary_channel === 'r2' && env.img_r2) {
    const obj = await env.img_r2.get(id);
    if (obj) {
      const headers = buildHeaders(obj.httpMetadata?.contentType || row.mime_type, row.file_name, false);
      if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
      headers.set('Content-Length', String(obj.size));
      return new Response(obj.body, { status: 200, headers });
    }
    // R2 意外缺失时自动回退 Telegram 冷备
    if (row.tg_file_id || row.tg_chunks) {
      return serveFromTelegram(env, row, false);
    }
    return new Response('File not found in R2', { status: 404 });
  }

  return serveFromTelegram(env, row, false);
}
