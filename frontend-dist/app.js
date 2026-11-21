import { isAnimatedImage } from '/animated.js';

const IMAGE_EXTS = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico', 'tif', 'tiff', 'heic', 'heif', 'apng'
]);

const state = {
  session: { authenticated: false, passwordRequired: true },
  uploadResults: [],
  gallery: { page: 1, limit: 100, total: 0 }
};

const $ = (id) => document.getElementById(id);

function showToast(msg, duration = 2600) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), duration);
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
    const res = await fetch('/api/session');
    state.session = await res.json();
  } catch {
    state.session = { authenticated: false, passwordRequired: true };
  }
  renderAuthBar();
}

function renderAuthBar() {
  const statusEl = $('authStatus');
  const btn = $('authActionBtn');
  if (!state.session.passwordRequired) {
    statusEl.textContent = '免密模式';
    btn.classList.add('hidden');
  } else if (state.session.authenticated) {
    statusEl.textContent = '已登录';
    btn.textContent = '退出';
    btn.classList.remove('hidden');
  } else {
    statusEl.textContent = '未登录';
    btn.textContent = '登录';
    btn.classList.remove('hidden');
  }
}

let turnstileWidgetId = null;
let turnstileToken = '';
let turnstileScriptPromise = null;

function loadTurnstileScript() {
  if (window.turnstile) return Promise.resolve();
  if (turnstileScriptPromise) return turnstileScriptPromise;
  turnstileScriptPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Turnstile 加载失败'));
    document.head.appendChild(s);
  });
  return turnstileScriptPromise;
}

async function ensureTurnstileWidget() {
  const siteKey = state.session.turnstileSiteKey;
  if (!siteKey) return;
  await loadTurnstileScript();
  if (turnstileWidgetId !== null) {
    turnstileToken = '';
    window.turnstile.reset(turnstileWidgetId);
    return;
  }
  turnstileWidgetId = window.turnstile.render('#turnstileBox', {
    sitekey: siteKey,
    theme: 'light',
    callback: (token) => { turnstileToken = token; },
    'expired-callback': () => { turnstileToken = ''; },
    'error-callback': () => { turnstileToken = ''; },
  });
}

function openLoginModal() {
  $('loginModal').classList.remove('hidden');
  $('loginPassword').focus();
  ensureTurnstileWidget().catch(() => showToast('人机验证组件加载失败'));
}

$('authActionBtn').addEventListener('click', async () => {
  if (state.session.authenticated) {
    await fetch('/api/login', { method: 'DELETE' });
    showToast('已退出登录');
    await checkSession();
  } else {
    openLoginModal();
  }
});

$('closeLoginModal').addEventListener('click', () => {
  $('loginModal').classList.add('hidden');
});

$('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (state.session.turnstileSiteKey && !turnstileToken) {
    showToast('请等待人机验证完成');
    return;
  }
  const password = $('loginPassword').value;
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, turnstileToken })
  });
  if (res.ok) {
    $('loginModal').classList.add('hidden');
    $('loginPassword').value = '';
    turnstileToken = '';
    showToast('登录成功');
    await checkSession();
    if ($('tab-gallery').classList.contains('active')) loadGallery();
  } else {
    const err = await res.json().catch(() => ({}));
    showToast(err.error || '登录失败');
    if (turnstileWidgetId !== null && window.turnstile) {
      turnstileToken = '';
      window.turnstile.reset(turnstileWidgetId);
    }
  }
});

/* ==================== 压缩与上传 ==================== */
function compressImageToWebp(file, maxDimension = 2048, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const origW = img.width;
      const origH = img.height;
      if ((file.type || '').includes('svg')) {
        URL.revokeObjectURL(url);
        return resolve({ file, width: origW, height: origH });
      }
      let w = origW;
      let h = origH;
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
          return resolve({ file, width: w, height: h });
        }
        const dot = file.name.lastIndexOf('.');
        const newName = (dot > 0 ? file.name.slice(0, dot) : file.name) + '.webp';
        resolve({ file: new File([blob], newName, { type: 'image/webp' }), width: w, height: h });
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
        openLoginModal();
        return reject(new Error('请先登录后再上传'));
      }
      let data;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        data = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
        resolve(data);
      } else {
        reject(new Error(data?.error || xhr.responseText || `HTTP ${xhr.status}`));
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

  return { metaEl, fill, actions };
}

async function computeSha256(file) {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function checkDuplicateByHash(fileHash) {
  const res = await fetch(`/api/upload?hash=${encodeURIComponent(fileHash)}`);
  if (res.status === 401) {
    openLoginModal();
    throw new Error('请先登录后再上传');
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.exists ? data : null;
}

async function handleFiles(files) {
  const imageFiles = files.filter((f) => {
    if (!isImageFile(f)) {
      showToast(`已跳过非图片文件: ${f.name}`);
      return false;
    }
    return true;
  });

  if (imageFiles.length === 0) return;

  let uploadedNewCount = 0;
  for (const file of imageFiles) {
    const ui = createUploadRow(file);
    try {
      ui.metaEl.textContent = `原图 ${formatSize(file.size)} · 校验去重中...`;
      const fileHash = await computeSha256(file);
      let res = await checkDuplicateByHash(fileHash);
      let isAnimated = false;

      if (res) {
        ui.metaEl.textContent = `原图 ${formatSize(file.size)} → 已存在`;
      } else {
        isAnimated = await isAnimatedImage(file);
        const folder = $('uploadFolder').value.trim().replace(/^\/+|\/+$/g, '');
        const nameType = $('uploadNameType').value;
        const formData = new FormData();
        formData.append('folder', folder);
        formData.append('nameType', nameType);
        formData.append('fileHash', fileHash);
        formData.append('originalName', file.name);
        formData.append('originalSize', String(file.size));

        if (isAnimated) {
          ui.metaEl.textContent = `动图 ${formatSize(file.size)} → 原格式直传 R2`;
          formData.append('file', file);
        } else {
          ui.metaEl.textContent = `原图 ${formatSize(file.size)} → 正在压缩 WebP...`;
          const { file: webpFile, width, height } = await compressImageToWebp(file, 2048, 0.8);
          ui.metaEl.textContent = `原图 ${formatSize(file.size)} → WebP ${formatSize(webpFile.size)} (${width}×${height}) · 未备份原图`;
          formData.append('file', webpFile);
          if (width) formData.append('width', String(width));
          if (height) formData.append('height', String(height));
        }

        res = await sendUploadXhr('/api/upload', formData, (pct) => {
          ui.fill.style.width = `${pct}%`;
        });
        uploadedNewCount++;
      }

      ui.fill.style.width = '100%';
      ui.fill.style.background = 'var(--success)';

      const tag = document.createElement('span');
      if (res.deduplicated) {
        tag.className = 'tag tag-info';
        tag.textContent = '秒传 (已存在)';
      } else if (isAnimated) {
        tag.className = 'tag tag-info';
        tag.textContent = 'R2 动图';
      } else {
        tag.className = 'tag tag-ok';
        tag.textContent = 'R2 WebP';
      }
      ui.metaEl.append(' ', tag);

      const copyUrlBtn = document.createElement('button');
      copyUrlBtn.className = 'btn btn-ghost btn-sm';
      copyUrlBtn.textContent = '复制链接';
      copyUrlBtn.onclick = () => copyText(res.url, '直链');

      const copyMdBtn = document.createElement('button');
      copyMdBtn.className = 'btn btn-primary btn-sm';
      copyMdBtn.textContent = 'Markdown';
      copyMdBtn.onclick = () => copyText(res.markdown, 'Markdown');

      ui.actions.append(copyUrlBtn, copyMdBtn);
      state.uploadResults.unshift({ name: file.name, url: res.url, md: res.markdown });
      $('copyAllMdBtn').disabled = false;
    } catch (err) {
      ui.fill.style.background = 'var(--danger)';
      const errTag = document.createElement('span');
      errTag.className = 'tag tag-err';
      errTag.textContent = err.message;
      ui.metaEl.append(' ', errTag);
    }
  }

  if (uploadedNewCount > 0) {
    showToast('已压缩上传至 R2（网页端未保存原图，请自行本地备份）', 3600);
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
  const md = state.uploadResults.map((r) => r.md).join('\n');
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
    page: String(state.gallery.page),
    limit: String(state.gallery.limit),
    q: $('searchInput').value.trim(),
    folder: $('dirInput').value.trim()
  });
  const res = await fetch(`/api/images?${params.toString()}`);
  if (res.status === 401) {
    openLoginModal();
    return;
  }
  const data = await res.json();
  const items = data.items || [];
  state.gallery.total = data.total || 0;

  const stats = data.stats || {};
  $('galleryCount').textContent =
    `共 ${stats.total_count ?? state.gallery.total} 张 · R2 已用 ${formatSize(stats.r2_bytes || 0)}`;

  const grid = $('galleryGrid');
  grid.innerHTML = '';

  for (const row of items) {
    const fileUrl = `${location.origin}/file/${row.id}`;

    const card = document.createElement('div');
    card.className = 'card';

    const imgWrap = document.createElement('div');
    imgWrap.className = 'card-img-wrap';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/file/${row.id}`;
    img.alt = row.original_name || row.file_name;
    imgWrap.onclick = () => openPreview(row);
    imgWrap.appendChild(img);

    const body = document.createElement('div');
    body.className = 'card-body';

    const title = document.createElement('div');
    title.className = 'card-title';
    title.textContent = row.original_name || row.file_name;
    title.title = row.id;

    const metaRow = document.createElement('div');
    metaRow.className = 'card-meta';
    const sizeText = formatSize(row.size_bytes);
    const dimText = (row.width && row.height) ? `${row.width}×${row.height}` : 'R2';
    const chTag = document.createElement('span');
    chTag.textContent = dimText;
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
    mdBtn.onclick = () => copyText(`![${row.original_name || row.file_name}](${fileUrl})`, 'Markdown');

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.textContent = '删除';
    delBtn.onclick = async () => {
      if (!confirm(`确认删除 ${row.original_name || row.file_name}？`)) return;
      const delRes = await fetch(`/api/images?id=${encodeURIComponent(row.id)}`, { method: 'DELETE' });
      if (delRes.ok) {
        showToast('已删除');
        loadGallery();
      } else {
        showToast('删除失败');
      }
    };

    actions.append(copyBtn, mdBtn, delBtn);
    body.append(title, metaRow, actions);
    card.append(imgWrap, body);
    grid.appendChild(card);
  }

  const totalPages = Math.max(1, Math.ceil(state.gallery.total / state.gallery.limit));
  $('pageInfo').textContent = `第 ${state.gallery.page} / ${totalPages} 页`;
  $('prevPageBtn').disabled = state.gallery.page <= 1;
  $('nextPageBtn').disabled = state.gallery.page >= totalPages;
}

function openPreview(row) {
  $('previewImg').src = `/file/${row.id}`;
  $('previewMeta').textContent = `${row.original_name || row.file_name} · ${row.width || '?'}×${row.height || '?'} · ${formatSize(row.size_bytes)}`;
  $('previewModal').classList.remove('hidden');
}

$('closePreviewModal').addEventListener('click', () => {
  $('previewModal').classList.add('hidden');
  $('previewImg').src = '';
});

$('refreshGalleryBtn').addEventListener('click', () => {
  state.gallery.page = 1;
  loadGallery();
});
$('searchInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    state.gallery.page = 1;
    loadGallery();
  }
});
$('prevPageBtn').addEventListener('click', () => {
  state.gallery.page = Math.max(1, state.gallery.page - 1);
  loadGallery();
});
$('nextPageBtn').addEventListener('click', () => {
  state.gallery.page += 1;
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
