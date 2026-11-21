/**
 * ImgHub 本地图片上传脚本（供 Typora / Obsidian / 桌面悬浮球 / 其他脚本调用）
 *
 * 用法:
 *   node tools/upload.mjs [--progress] <本地图片路径或HTTP图片URL ...>
 *
 * 参数说明:
 *   --progress  可选，向 stderr 输出 PROGRESS:<pct> 与 DEDUP:1 进度信息（Typora 调用时请勿加此参数）
 *
 * 配置来源（优先读取进程环境变量，其次读取项目根目录 ../.env）:
 *   API_TOKEN         必填，与 Cloudflare Pages 环境变量 API_TOKEN 一致（Bearer 鉴权）
 *   IMGHUB_URL        可选，默认 https://imbed.970799.xyz
 *   LOCAL_BACKUP_DIR  可选，本地原图按月备份根目录，默认 D:\OneDrive\文档\archive\imghub_bk
 *
 * 处理规则:
 *   1. 本地原图备份：自动按月份子目录（如 2026-11）复制一份原图到 LOCAL_BACKUP_DIR（以 <hash前8位>_<原文件名> 命名防覆盖与重复）
 *   2. SHA-256 秒传预检：若服务端已存在相同原图哈希，直接返回旧 URL，跳过压缩与上传
 *   3. 动图（多帧 GIF/WebP/APNG）：跳过压缩，原格式直接上传至 Cloudflare R2
 *   4. 静态图：使用 sharp（BMP/ICO 自动经 Windows System.Drawing 转 PNG 兜底）等比缩放到 <= 2048px、WebP 0.8 上传至 Cloudflare R2
 *   5. 成功后向 stdout 逐行打印图片访问 URL
 */
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import sharp from 'sharp';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'https://imbed.970799.xyz';
const DEFAULT_BACKUP_DIR = 'D:\\OneDrive\\文档\\archive\\imghub_bk';

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

async function convertToPngFallback(buffer) {
  const tmpIn = path.join(os.tmpdir(), `imghub_in_${crypto.randomUUID()}.bin`);
  const tmpOut = path.join(os.tmpdir(), `imghub_out_${crypto.randomUUID()}.png`);
  await fs.writeFile(tmpIn, buffer);
  try {
    const psCmd = `Add-Type -AssemblyName System.Drawing; $img=[System.Drawing.Image]::FromFile('${tmpIn.replace(/'/g, "''")}'); try { $img.Save('${tmpOut.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png) } finally { $img.Dispose() }`;
    await execFileAsync('powershell.exe', ['-NoProfile', '-Command', psCmd], { windowsHide: true });
    return await fs.readFile(tmpOut);
  } finally {
    await fs.rm(tmpIn, { force: true }).catch(() => {});
    await fs.rm(tmpOut, { force: true }).catch(() => {});
  }
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

async function backupOriginalLocally(buffer, fileName, fileHash, backupRoot) {
  if (!backupRoot) return;
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthDir = path.join(backupRoot, ym);
  await fs.mkdir(monthDir, { recursive: true });

  const safeName = (fileName || 'image.png').replace(/[<>:"/\\|?*]/g, '_');
  const targetPath = path.join(monthDir, `${fileHash.slice(0, 8)}_${safeName}`);
  try {
    await fs.access(targetPath);
  } catch {
    await fs.writeFile(targetPath, buffer);
  }
}

async function uploadOne(input, baseUrl, apiToken, backupRoot, reportProgress = false) {
  const emit = (pct) => {
    if (reportProgress) process.stderr.write(`PROGRESS:${pct}\n`);
  };
  emit(5);
  const { buffer, fileName } = await readInputFile(input);
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');

  // 1. 先在本地 OneDrive 按月份子文件夹备份一份无损原图
  await backupOriginalLocally(buffer, fileName, fileHash, backupRoot);

  // 2. SHA-256 秒传预检
  try {
    const checkRes = await fetch(`${baseUrl}/api/upload?hash=${fileHash}`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });
    if (checkRes.ok) {
      const checkData = await checkRes.json().catch(() => null);
      if (checkData?.exists && checkData?.url) {
        if (reportProgress) process.stderr.write('DEDUP:1\n');
        emit(100);
        return checkData.url;
      }
    }
  } catch {
    // 预检失败时继续走正常上传
  }

  const origMime = getMime(fileName);
  const ext = path.extname(fileName).slice(1).toLowerCase();

  let isAnimated = false;
  let meta = {};
  let sharpInput = buffer;
  if (ext !== 'svg') {
    try {
      meta = await sharp(buffer, { animated: true }).metadata();
      isAnimated = (meta.pages || 1) > 1;
    } catch {
      sharpInput = await convertToPngFallback(buffer);
      meta = await sharp(sharpInput).metadata();
      isAnimated = false;
    }
  }

  const form = new FormData();
  form.append('folder', '');
  form.append('nameType', 'default');
  form.append('fileHash', fileHash);
  form.append('originalName', fileName);
  form.append('originalSize', String(buffer.length));

  if (isAnimated || ext === 'svg') {
    form.append('file', new Blob([buffer], { type: origMime }), fileName);
    if (meta.width) form.append('width', String(meta.width));
    if (meta.height) form.append('height', String(meta.height));
  } else {
    const pipeline = sharp(sharpInput)
      .rotate()
      .resize(2048, 2048, { fit: 'inside', withoutEnlargement: true });
    const { data: webpBuf, info } = await pipeline
      .webp({ quality: 80 })
      .toBuffer({ resolveWithObject: true });

    const baseName = fileName.replace(/\.[^.]+$/, '') || 'image';
    const useOriginal = ext === 'webp' && Math.max(meta.width || 0, meta.height || 0) <= 2048 && webpBuf.length >= buffer.length;
    const uploadBuf = useOriginal ? buffer : webpBuf;
    const uploadName = `${baseName}.webp`;

    form.append('file', new Blob([uploadBuf], { type: 'image/webp' }), uploadName);
    if (info.width) form.append('width', String(info.width));
    if (info.height) form.append('height', String(info.height));
  }

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
  const backupRoot = (process.env.LOCAL_BACKUP_DIR || envFile.LOCAL_BACKUP_DIR || DEFAULT_BACKUP_DIR).trim();

  if (!apiToken) {
    console.error('未找到 API_TOKEN，请在项目根目录 .env 中填写 API_TOKEN');
    process.exit(1);
  }

  for (const input of inputs) {
    const url = await uploadOne(input, baseUrl, apiToken, backupRoot, reportProgress);
    console.log(url);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
