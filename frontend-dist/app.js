import { isAnimatedImage } from '/animated.js';

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif', 'apng'
]);

const state = {
  session: { valid: false, authType: null, adminRequired: true, userRequired: false },
  uploadResults: [],
  gallery: { start: 0, count: 30, total: 0 }
};

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), 2400);
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function isImageFile(file) {
  if (file.type && file.type.startsWith('image/')) return true;
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  return IMAGE_EXTS.has(ext);
}

async function copyText(text, label = '链接') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(`已复制${label}`);
  } catch {
    showToast('复制失败，请手动复制');
  }
}

/* ==================== 鉴权 ==================== */
async function checkSession() {
  try {
    const res = await fetch('/api/auth/sessionCheck');
    const data = await res.json();
    state.session = data;
  } catch {
    state.session = { valid: false, adminRequired: true, userRequired: false };
  }
  renderAuthBar();
}

function renderAuthBar() {
  const statusEl = $('authStatus');
  const btn = $('authActionBtn');
  if (state.session.valid) {
    statusEl.textContent = state.session.authType === 'admin' ? '管理员已登录' : '已登录';
    btn.textContent = '切换账号';
    btn.classList.remove('hidden');
  } else if (!state.session.userRequired) {
    statusEl.textContent = '免密上传';
    btn.textContent = '登录';
    btn.classList.add('hidden');
  } else {
    statusEl.textContent = '未登录';
    btn.textContent = '登录';
    btn.classList.remove('hidden');
  }
}

$('authActionBtn').addEventListener('click', () => {
  $('userLoginModal').classList.remove('hidden');
  $('userAuthCode').focus();
});

$('closeLoginModal').addEventListener('click', () => {
  $('userLoginModal').classList.add('hidden');
});

$('userLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const authCode = $('userAuthCode').value;
  const res = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ authCode })
  });
  if (res.ok) {
    $('userLoginModal').classList.add('hidden');
    $('userAuthCode').value = '';
    showToast('登录成功');
    await checkSession();
  } else {
    showToast('认证码错误');
  }
});

/* ==================== 压缩与上传 ==================== */
function compressImageForDual(file, maxDimension = 2048, quality = 0.8) {
  if ((file.type || '').includes('svg')) return Promise.resolve(file);
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let w = img.width;
      let h = img.height;
      const maxSide = Math.max(w, h);
      if (maxSide > maxDimension) {
        const ratio = maxDimension / maxSide;
        w = Math.max(1, Math.round(w * ratio));
        h = Math.max(1, Math.round(h * ratio));
      }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (!blob) return reject(new Error('WebP 转换失败'));
        if (file.type === 'image/webp' && maxSide <= maxDimension && blob.size >= file.size) {
          return resolve(file);
        }
        const dot = file.name.lastIndexOf('.');
        const newName = (dot > 0 ? file.name.slice(0, dot) : file.name) + '.webp';
        resolve(new File([blob], newName, { type: 'image/webp' }));
      }, 'image/webp', quality);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('图片解码失败'));
    };
    img.src = url;
  });
}

function sendUploadXhr(url, formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 401) {
        $('userLoginModal').classList.remove('hidden');
        return reject(new Error('未登录或认证已过期'));
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error('响应解析失败'));
        }
      } else {
        reject(new Error(xhr.responseText || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    xhr.send(formData);
  });
}

function createUploadRow(file) {
  const item = document.createElement('div');
  item.className = 'upload-item';

  const thumb = document.createElement('img');
  thumb.className = 'upload-thumb';
  thumb.src = URL.createObjectURL(file);

  const info = document.createElement('div');
  info.className = 'upload-info';

  const nameEl = document.createElement('div');
  nameEl.className = 'upload-name';
  nameEl.textContent = file.name;

  const metaEl = document.createElement('div');
  metaEl.className = 'upload-meta';
  metaEl.textContent = `原图 ${formatSize(file.size)} · 准备中...`;

  const bar = document.createElement('div');
  bar.className = 'progress-bar';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  bar.appendChild(fill);

  info.append(nameEl, metaEl, bar);

  const actions = document.createElement('div');
  actions.className = 'upload-actions';

  item.append(thumb, info, actions);
  $('uploadList').prepend(item);

  return { metaEl, fill, actions, thumb };
}

async function handleFiles(files) {
  for (const file of files) {
    if (!isImageFile(file)) {
      showToast(`已跳过非图片文件: ${file.name}`);
      continue;
    }

    const ui = createUploadRow(file);
    try {
      const animated = await isAnimatedImage(file);
      const folder = $('uploadFolder').value.trim().replace(/^\/+|\/+$/g, '');
      const nameType = $('uploadNameType').value;
      const formData = new FormData();

      let query;
      if (animated) {
        ui.metaEl.textContent = `动图 ${formatSize(file.size)} → 仅传 Telegram`;
        formData.append('file', file);
        query = new URLSearchParams({
          uploadChannel: 'telegram',
          serverCompress: 'false',
          uploadNameType: nameType,
          uploadFolder: folder,
          returnFormat: 'full'
        });
      } else {
        ui.metaEl.textContent = `原图 ${formatSize(file.size)} → 正在生成 WebP...`;
        const webpFile = await compressImageForDual(file, 2048, 0.8);
        ui.metaEl.textContent = `原图 ${formatSize(file.size)} → WebP ${formatSize(webpFile.size)}`;
        formData.append('file', webpFile);
        formData.append('originalFile', file);
        query = new URLSearchParams({
          uploadChannel: 'dual',
          uploadNameType: nameType,
          uploadFolder: folder,
          returnFormat: 'full'
        });
      }

      const res = await sendUploadXhr(`/upload?${query.toString()}`, formData, (pct) => {
        ui.fill.style.width = `${pct}%`;
      });

      const entry = Array.isArray(res) ? res[0] : res;
      const fileUrl = entry.publicUrl || entry.src;
      const backupStatus = entry.backupStatus;

      ui.fill.style.width = '100%';
      ui.fill.style.background = 'var(--success)';

      const tag = document.createElement('span');
      if (animated) {
        tag.className = 'tag tag-info';
        tag.textContent = 'TG 动图';
      } else if (backupStatus === 'ok') {
        tag.className = 'tag tag-ok';
        tag.textContent = 'R2 + TG冷备';
      } else {
        tag.className = 'tag tag-warn';
        tag.textContent = `R2成功 (冷备:${backupStatus || '跳过'})`;
      }
      ui.metaEl.append(' ', tag);

      const copyUrlBtn = document.createElement('button');
      copyUrlBtn.className = 'btn btn-ghost btn-sm';
      copyUrlBtn.textContent = '复制链接';
      copyUrlBtn.onclick = () => copyText(fileUrl, '直链');

      const copyMdBtn = document.createElement('button');
      copyMdBtn.className = 'btn btn-primary btn-sm';
      copyMdBtn.textContent = 'Markdown';
      copyMdBtn.onclick = () => copyText(`![${file.name}](${fileUrl})`, 'Markdown');

      ui.actions.append(copyUrlBtn, copyMdBtn);
      state.uploadResults.unshift({ name: file.name, url: fileUrl });
      $('copyAllMdBtn').disabled = false;
    } catch (err) {
      ui.fill.style.background = 'var(--danger)';
      const errTag = document.createElement('span');
      errTag.className = 'tag tag-err';
      errTag.textContent = err.message;
      ui.metaEl.append(' ', errTag);
    }
  }
}

/* 拖拽 / 点击 / 粘贴 */
const dropzone = $('dropzone');
dropzone.addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  if (e.target.files.length) handleFiles([...e.target.files]);
  e.target.value = '';
});
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length) handleFiles([...e.dataTransfer.files]);
});
window.addEventListener('paste', (e) => {
  if (!$('tab-upload').classList.contains('active')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) handleFiles(files);
});

$('copyAllMdBtn').addEventListener('click', () => {
  const md = state.uploadResults.map((r) => `![${r.name}](${r.url})`).join('\n');
  copyText(md, '全部 Markdown');
});
$('clearQueueBtn').addEventListener('click', () => {
  $('uploadList').innerHTML = '';
  state.uploadResults = [];
  $('copyAllMdBtn').disabled = true;
});

/* ==================== 图库管理 ==================== */
async function loadGallery() {
  const params = new URLSearchParams({
    start: String(state.gallery.start),
    count: String(state.gallery.count),
    recursive: 'true',
    search: $('searchInput').value.trim(),
    dir: $('dirInput').value.trim()
  });
  const res = await fetch(`/api/manage/list?${params.toString()}`);
  if (res.status === 401) {
    $('adminGate').classList.remove('hidden');
    $('galleryContent').classList.add('hidden');
    return;
  }
  $('adminGate').classList.add('hidden');
  $('galleryContent').classList.remove('hidden');

  const data = await res.json();
  const files = data.files || [];
  state.gallery.total = data.totalCount || files.length;
  $('galleryCount').textContent = `共 ${state.gallery.total} 张`;

  const grid = $('galleryGrid');
  grid.innerHTML = '';

  for (const item of files) {
    const meta = item.metadata || {};
    const fileId = item.name;
    const fileUrl = `${location.origin}/file/${fileId}`;
    const hasBackup = meta.BackupChannel === 'TelegramNew' && meta.BackupStatus === 'ok';

    const card = document.createElement('div');
    card.className = 'card';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'card-img-wrap';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/file/${fileId}`;
    img.alt = meta.FileName || fileId;
    imgWrap.onclick = () => openPreview(fileId, meta, hasBackup);
    imgWrap.appendChild(img);

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = meta.FileName || fileId;
    title.title = fileId;

    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta';
    const sizeText = meta.OriginalFileSize
      ? `${meta.FileSize || '?'}MB (原图 ${meta.OriginalFileSize}MB)`
      : `${meta.FileSize || '?'}MB`;
    const chTag = document.createElement('span');
    chTag.textContent = hasBackup ? 'R2+TG' : (meta.Channel === 'CloudflareR2' ? 'R2' : 'TG');
    metaRow.append(document.createTextNode(sizeText), chTag);

    const actions = document.createElement('div');
    actions.className = 'card-actions';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'btn btn-ghost btn-sm';
    copyBtn.textContent = '链接';
    copyBtn.onclick = () => copyText(fileUrl, '直链');

    const mdBtn = document.createElement('button');
    mdBtn.className = 'btn btn-ghost btn-sm';
    mdBtn.textContent = 'MD';
    mdBtn.onclick = () => copyText(`![${meta.FileName || fileId}](${fileUrl})`, 'Markdown');

    actions.append(copyBtn, mdBtn);

    if (hasBackup) {
      const origLink = document.createElement('a');
      origLink.className = 'btn btn-ghost btn-sm';
      origLink.textContent = '原图';
      origLink.href = `/file/${fileId}?original=1`;
      origLink.target = '_blank';
      origLink.rel = 'noopener';
      actions.appendChild(origLink);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = '删除';
    delBtn.onclick = async () => {
      if (!confirm(`确认删除 ${meta.FileName || fileId}？`)) return;
      const delRes = await fetch(`/api/manage/delete/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
      if (delRes.ok) {
        showToast('已删除');
        loadGallery();
      } else {
        showToast('删除失败');
      }
    };
    actions.appendChild(delBtn);

    body.append(title, metaRow, actions);
    card.append(imgWrap, body);
    grid.appendChild(card);
  }

  const page = Math.floor(state.gallery.start / state.gallery.count) + 1;
  const totalPages = Math.max(1, Math.ceil(state.gallery.total / state.gallery.count));
  $('pageInfo').textContent = `第 ${page} / ${totalPages} 页`;
  $('prevPageBtn').disabled = state.gallery.start <= 0;
  $('nextPageBtn').disabled = state.gallery.start + state.gallery.count >= state.gallery.total;
}

function openPreview(fileId, meta, hasBackup) {
  $('previewImg').src = `/file/${fileId}`;
  $('previewMeta').textContent = `${meta.FileName || fileId} · ${meta.Width || '?'}×${meta.Height || '?'}`;
  const link = $('previewOriginalLink');
  if (hasBackup) {
    link.href = `/file/${fileId}?original=1`;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
  $('previewModal').classList.remove('hidden');
}

$('closePreviewModal').addEventListener('click', () => {
  $('previewModal').classList.add('hidden');
  $('previewImg').src = '';
});

$('adminLoginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/auth/adminLogin', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: $('adminUser').value,
      password: $('adminPass').value
    })
  });
  if (res.ok) {
    showToast('管理员登录成功');
    await checkSession();
    loadGallery();
  } else {
    showToast('账号或密码错误');
  }
});

$('refreshGalleryBtn').addEventListener('click', () => {
  state.gallery.start = 0;
  loadGallery();
});
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    state.gallery.start = 0;
    loadGallery();
  }
});
$('prevPageBtn').addEventListener('click', () => {
  state.gallery.start = Math.max(0, state.gallery.start - state.gallery.count);
  loadGallery();
});
$('nextPageBtn').addEventListener('click', () => {
  state.gallery.start += state.gallery.count;
  loadGallery();
});

/* ==================== Tab 切换 ==================== */
document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    $(`tab-${btn.dataset.tab}`).classList.add('active');
    if (btn.dataset.tab === 'gallery') loadGallery();
  });
});

checkSession();

