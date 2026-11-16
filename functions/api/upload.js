import { isAuthorized, jsonResponse } from '../lib/auth.js';
import { getTgConfig, sendDocument, uploadLargeDocument } from '../lib/telegram.js';

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif', 'apng',
]);

const TG_CHUNK_THRESHOLD = 16 * 1024 * 1024;

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

async function uploadToTelegram(cfg, file, fileName) {
  if (file.size > TG_CHUNK_THRESHOLD) {
    const chunks = await uploadLargeDocument(cfg, file, fileName);
    return { tgFileId: null, tgChunks: JSON.stringify(chunks) };
  }
  const res = await sendDocument(cfg, file, fileName);
  return { tgFileId: res.fileId, tgChunks: null };
}

export async function onRequestPost({ request, env }) {
  if (!(await isAuthorized(request, env))) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  if (!env.img_bed_db) {
    return jsonResponse({ error: 'D1 database (img_bed_db) is not bound' }, 500);
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
  const channel = form.get('channel') || url.searchParams.get('channel') || 'dual';
  const folder = sanitizeFolder(form.get('folder') || url.searchParams.get('folder') || '');
  const nameType = String(form.get('nameType') || url.searchParams.get('nameType') || 'default');
  const width = parseInt(form.get('width'), 10) || null;
  const height = parseInt(form.get('height'), 10) || null;
  const originalFile = form.get('originalFile');

  const id = buildFileId(folder, file.name, file.type, nameType);
  const mimeType = file.type || 'application/octet-stream';
  const tgCfg = getTgConfig(env);
  const now = Date.now();

  let primaryChannel = 'r2';
  let tgFileId = null;
  let tgChunks = null;
  let backupStatus = 'none';
  let backupError = null;
  let originalName = file.name;
  let originalMime = mimeType;
  let originalSize = file.size;

  if (channel === 'tg') {
    if (!tgCfg) {
      return jsonResponse({ error: '动图需通过 Telegram 存储，请先配置 TG_BOT_TOKEN 与 TG_CHAT_ID' }, 400);
    }
    primaryChannel = 'tg';
    try {
      const tgRes = await uploadToTelegram(tgCfg, file, file.name);
      tgFileId = tgRes.tgFileId;
      tgChunks = tgRes.tgChunks;
      backupStatus = 'ok';
    } catch (err) {
      return jsonResponse({ error: `Telegram 上传失败: ${err.message}` }, 502);
    }
  } else {
    if (!env.img_r2) {
      return jsonResponse({ error: 'R2 bucket (img_r2) is not bound' }, 500);
    }
    await env.img_r2.put(id, file.stream(), {
      httpMetadata: { contentType: mimeType },
    });

    const hasOrig = originalFile && typeof originalFile.arrayBuffer === 'function' && originalFile.size > 0;
    const backupSource = hasOrig ? originalFile : file;
    originalName = backupSource.name || file.name;
    originalMime = backupSource.type || mimeType;
    originalSize = backupSource.size;

    if (!tgCfg) {
      backupStatus = 'unconfigured';
    } else {
      try {
        const tgRes = await uploadToTelegram(tgCfg, backupSource, originalName);
        tgFileId = tgRes.tgFileId;
        tgChunks = tgRes.tgChunks;
        backupStatus = 'ok';
      } catch (err) {
        backupStatus = 'failed';
        backupError = err.message;
      }
    }
  }

  await env.img_bed_db
    .prepare(
      `INSERT INTO images (
        id, file_name, folder, mime_type, size_bytes, width, height,
        primary_channel, tg_file_id, tg_chunks, backup_status, backup_error,
        original_name, original_mime, original_size, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      file.name,
      folder,
      mimeType,
      file.size,
      width,
      height,
      primaryChannel,
      tgFileId,
      tgChunks,
      backupStatus,
      backupError,
      originalName,
      originalMime,
      originalSize,
      now
    )
    .run();

  const fileUrl = `${url.origin}/file/${id}`;
  return jsonResponse({
    ok: true,
    id,
    url: fileUrl,
    markdown: `![${originalName}](${fileUrl})`,
    primaryChannel,
    backupStatus,
    backupError,
    sizeBytes: file.size,
    originalSize,
  });
}

