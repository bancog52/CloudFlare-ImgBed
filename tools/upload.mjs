import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'https://imbed.970799.xyz';

const MIME_BY_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  tif: 'image/tiff',
  tiff: 'image/tiff',
  heic: 'image/heic',
  heif: 'image/heif',
  apng: 'image/apng',
};

async function loadEnv() {
  const envPath = path.join(ROOT_DIR, '.env');
  const map = {};
  try {
    const raw = await fs.readFile(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
      map[key] = val;
    }
  } catch {
    // 忽略 .env 不存在的情况
  }
  return map;
}

function getMime(fileName) {
  const ext = path.extname(fileName).slice(1).toLowerCase();
  return MIME_BY_EXT[ext] || 'application/octet-stream';
}

async function readInputFile(input) {
  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`下载图片失败: ${input} (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    const urlName = path.basename(new URL(input).pathname) || 'image.png';
    return { buffer: buf, fileName: urlName };
  }
  const buffer = await fs.readFile(input);
  return { buffer, fileName: path.basename(input) };
}

async function uploadOne(input, baseUrl, apiToken, reportProgress = false) {
  const emit = (pct) => {
    if (reportProgress) process.stderr.write(`PROGRESS:${pct}\n`);
  };
  emit(5);
  const { buffer, fileName } = await readInputFile(input);
  const origMime = getMime(fileName);
  const ext = path.extname(fileName).slice(1).toLowerCase();

  let isAnimated = false;
  let meta = {};
  if (ext !== 'svg') {
    try {
      meta = await sharp(buffer, { animated: true }).metadata();
      isAnimated = (meta.pages || 1) > 1;
    } catch {
      isAnimated = false;
    }
  }

  const form = new FormData();
  form.append('folder', 'typora');
  form.append('nameType', 'default');

  let payloadBytes = buffer.length;
  if (isAnimated) {
    form.append('channel', 'tg');
    form.append('file', new Blob([buffer], { type: origMime }), fileName);
  } else if (ext === 'svg') {
    form.append('channel', 'dual');
    form.append('file', new Blob([buffer], { type: origMime }), fileName);
    form.append('originalFile', new Blob([buffer], { type: origMime }), fileName);
    payloadBytes = buffer.length * 2;
  } else {
    const pipeline = sharp(buffer)
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true });
    const { data: webpBuf, info } = await pipeline
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    const baseName = fileName.replace(/\.[^.]+$/, '') || 'image';
    const useOriginal = ext === 'webp' && Math.max(meta.width || 0, meta.height || 0) <= 2048 && webpBuf.length >= buffer.length;
    const uploadBuf = useOriginal ? buffer : webpBuf;
    const uploadName = `${baseName}.webp`;
    payloadBytes = uploadBuf.length + buffer.length;

    form.append('channel', 'dual');
    form.append('file', new Blob([uploadBuf], { type: 'image/webp' }), uploadName);
    form.append('originalFile', new Blob([buffer], { type: origMime }), fileName);
    if (info.width) form.append('width', String(info.width));
    if (info.height) form.append('height', String(info.height));
  }

  if (reportProgress) process.stderr.write(`BYTES:${payloadBytes}\n`);
  emit(20);

  const res = await fetch(`${baseUrl}/api/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
    },
    body: form,
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data?.url) {
    throw new Error(data?.error || `上传失败 (HTTP ${res.status})`);
  }
  emit(100);
  return data.url;
}

async function main() {
  const args = process.argv.slice(2).filter(Boolean);
  const reportProgress = args.includes('--progress');
  const inputs = args.filter((a) => a !== '--progress');
  if (inputs.length === 0) {
    console.error('用法: node upload.mjs <图片路径1> [图片路径2 ...]');
    process.exit(1);
  }

  const envFile = await loadEnv();
  const apiToken = (process.env.API_TOKEN || envFile.API_TOKEN || '').trim();
  const baseUrl = (process.env.IMGHUB_URL || envFile.IMGHUB_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');

  if (!apiToken) {
    console.error('未找到 API_TOKEN，请在项目根目录 .env 中填写 API_TOKEN');
    process.exit(1);
  }

  for (const input of inputs) {
    const url = await uploadOne(input, baseUrl, apiToken, reportProgress);
    console.log(url);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});

