import { isAuthorized, jsonResponse } from '../lib/auth.js';

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif', 'apng',
]);

function sanitizeFolder(raw) {
  return String(raw || '')
    .replace(/\\/g, '/')
    .replace(/\.\./g, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/');
}

function getExt(name, mime) {
  const parts = (name || '').split('.');
  if (parts.length > 1) return parts.pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  const map = {
    'image/webp': 'webp',
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/gif': 'gif',
    'image/avif': 'avif',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/apng': 'apng',
  };
  return map[(mime || '').toLowerCase()] || 'bin';
}

function isImage(file) {
  const mime = (file.type || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return IMAGE_EXTS.has(getExt(file.name, mime));
}

function randomId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += chars[b % chars.length];
  return out;
}

function buildFileId(folder, fileName, mime, nameType) {
  const ext = getExt(fileName, mime);
  const now = new Date();
  const ym = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const baseName = (fileName || 'image').replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');

  let key;
  if (nameType === 'origin' && baseName) {
    key = `${baseName}.${ext}`;
  } else if (nameType === 'short') {
    key = `${randomId(6)}.${ext}`;
  } else if (nameType === 'index') {
    key = `${ym}/${randomId(10)}.${ext}`;
  } else {
    key = `${ym}/${randomId(6)}_${baseName || 'img'}.${ext}`;
  }
  return folder ? `${folder}/${key}` : key;
}

function buildDeduplicatedResult(origin, row) {
  const fileUrl = `${origin}/file/${row.id}`;
  const name = row.original_name || row.file_name || 'image';
  return {
    ok: true,
    exists: true,
    deduplicated: true,
    id: row.id,
    url: fileUrl,
    markdown: `![${name}](${fileUrl})`,
    primaryChannel: 'r2',
    sizeBytes: row.size_bytes,
    originalSize: row.original_size,
  };
}

function normalizeHash(raw) {
  const s = String(raw || '').trim().toLowerCase();
  return /^[a-f0-9]{64}$/.test(s) ? s : '';
}

async function computeSha256Hex(blob) {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function findByHash(db, hash) {
  if (!hash) return null;
  return db
    .prepare('SELECT id, file_name, original_name, primary_channel, size_bytes, original_size FROM images WHERE file_hash = ? LIMIT 1')
    .bind(hash)
    .first();
}

export async function onRequestGet({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!env.img_bed_db) {
    return jsonResponse({ error: 'D1 database (img_bed_db) is not bound' }, 500);
  }

  const url = new URL(request.url);
  const hash = normalizeHash(url.searchParams.get('hash'));
  if (!hash) {
    return jsonResponse({ error: 'Invalid hash' }, 400);
  }

  const existing = await findByHash(env.img_bed_db, hash);
  if (!existing) {
    return jsonResponse({ ok: true, exists: false });
  }
  return jsonResponse(buildDeduplicatedResult(url.origin, existing));
}

export async function onRequestPost({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }
  if (!env.img_bed_db) {
    return jsonResponse({ error: 'D1 database (img_bed_db) is not bound' }, 500);
  }
  if (!env.img_r2) {
    return jsonResponse({ error: 'R2 bucket (img_r2) is not bound' }, 500);
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!file || typeof file.arrayBuffer !== 'function' || file.size === 0) {
    return jsonResponse({ error: 'Missing file' }, 400);
  }
  if (!isImage(file)) {
    return jsonResponse({ error: '仅支持上传图片文件' }, 400);
  }

  const url = new URL(request.url);
  const folder = sanitizeFolder(form.get('folder') || url.searchParams.get('folder') || '');
  const nameType = String(form.get('nameType') || url.searchParams.get('nameType') || 'default');
  const width = parseInt(form.get('width'), 10) || null;
  const height = parseInt(form.get('height'), 10) || null;
  const originalName = String(form.get('originalName') || file.name);
  const originalSize = parseInt(form.get('originalSize'), 10) || file.size;

  let fileHash = normalizeHash(form.get('fileHash'));
  if (!fileHash) {
    fileHash = await computeSha256Hex(file);
  }

  const existing = await findByHash(env.img_bed_db, fileHash);
  if (existing) {
    return jsonResponse(buildDeduplicatedResult(url.origin, existing));
  }

  const id = buildFileId(folder, file.name, file.type, nameType);
  const mimeType = file.type || 'application/octet-stream';
  const now = Date.now();

  await env.img_r2.put(id, file.stream(), {
    httpMetadata: { contentType: mimeType },
  });

  await env.img_bed_db
    .prepare(
      `INSERT INTO images (
        id, file_name, folder, mime_type, size_bytes, width, height,
        primary_channel, tg_file_id, tg_chunks, backup_status, backup_error,
        original_name, original_mime, original_size, file_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'r2', NULL, NULL, 'none', NULL, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      file.name,
      folder,
      mimeType,
      file.size,
      width,
      height,
      originalName,
      mimeType,
      originalSize,
      fileHash,
      now
    )
    .run();

  const fileUrl = `${url.origin}/file/${id}`;
  return jsonResponse({
    ok: true,
    id,
    url: fileUrl,
    markdown: `![${originalName}](${fileUrl})`,
    primaryChannel: 'r2',
    sizeBytes: file.size,
    originalSize,
  });
}
