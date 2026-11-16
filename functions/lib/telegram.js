const CHUNK_SIZE = 16 * 1024 * 1024; // Telegram getFile 上限 20MB，留 4MB 安全余量
const MAX_CHUNKS = 50;

export function getTgConfig(env) {
  const botToken = (env.TG_BOT_TOKEN || '').trim();
  const chatId = (env.TG_CHAT_ID || '').trim();
  const proxyUrl = (env.TG_PROXY_URL || '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (!botToken || !chatId) return null;
  const domain = proxyUrl ? `https://${proxyUrl}` : 'https://api.telegram.org';
  return {
    botToken,
    chatId,
    apiBase: `${domain}/bot${botToken}`,
    fileBase: `${domain}/file/bot${botToken}`,
  };
}

export async function sendDocument(cfg, blob, fileName, caption = '') {
  const form = new FormData();
  form.append('chat_id', cfg.chatId);
  form.append('document', blob, fileName || 'image');
  if (caption) form.append('caption', caption);

  const res = await fetch(`${cfg.apiBase}/sendDocument`, {
    method: 'POST',
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Telegram HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  if (!data.ok || !data.result?.document?.file_id) {
    throw new Error(`Telegram API error: ${data.description || 'missing file_id'}`);
  }
  return {
    fileId: data.result.document.file_id,
    fileSize: data.result.document.file_size || blob.size,
  };
}

export async function uploadLargeDocument(cfg, file, fileName) {
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  if (totalChunks > MAX_CHUNKS) {
    throw new Error('原图超过分片上限');
  }

  const chunks = [];
  for (let i = 0; i < totalChunks; i++) {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    const chunkBlob = file.slice(start, end);
    const chunkName = `${fileName}.part${String(i).padStart(3, '0')}`;

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const info = await sendDocument(cfg, chunkBlob, chunkName, `Part ${i + 1}/${totalChunks}`);
        chunks.push({ index: i, fileId: info.fileId, size: info.fileSize });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (lastErr) throw lastErr;
  }
  return chunks;
}

export async function resolveTgFileUrl(cfg, fileId) {
  const res = await fetch(`${cfg.apiBase}/getFile?file_id=${encodeURIComponent(fileId)}`);
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.ok || !data.result?.file_path) return null;
  return `${cfg.fileBase}/${data.result.file_path}`;
}

export function createChunkedStream(cfg, chunks) {
  const sorted = [...chunks].sort((a, b) => a.index - b.index);
  let idx = 0;
  let reader = null;

  return new ReadableStream({
    async pull(controller) {
      while (true) {
        if (!reader) {
          if (idx >= sorted.length) {
            controller.close();
            return;
          }
          const fileUrl = await resolveTgFileUrl(cfg, sorted[idx].fileId);
          if (!fileUrl) {
            controller.error(new Error(`Missing Telegram chunk ${idx}`));
            return;
          }
          const res = await fetch(fileUrl);
          if (!res.ok || !res.body) {
            controller.error(new Error(`Failed to fetch chunk ${idx}: ${res.status}`));
            return;
          }
          reader = res.body.getReader();
          idx++;
        }

        const { done, value } = await reader.read();
        if (done) {
          reader = null;
          continue;
        }
        controller.enqueue(value);
        return;
      }
    },
    cancel() {
      if (reader) reader.cancel().catch(() => {});
    },
  });
}
