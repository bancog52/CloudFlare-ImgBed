const textAt = (bytes, start, length) =>
  String.fromCharCode(...bytes.subarray(start, start + length));

function createReader(file) {
  let start = -1;
  let cached = new Uint8Array();
  return async (offset, length) => {
    if (offset < 0 || offset + length > file.size) {
      throw new Error('Truncated image');
    }
    if (offset < start || offset + length > start + cached.length) {
      start = offset;
      cached = new Uint8Array(
        await file.slice(offset, offset + Math.max(length, 65536)).arrayBuffer()
      );
    }
    if (offset + length > start + cached.length) {
      throw new Error('Truncated image');
    }
    return cached.subarray(offset - start, offset - start + length);
  };
}

async function isAnimatedGif(read) {
  const header = await read(0, 13);
  let offset = 13 + (header[10] & 0x80 ? 3 * 2 ** ((header[10] & 7) + 1) : 0);
  let frames = 0;
  while (true) {
    const marker = (await read(offset, 1))[0];
    if (marker === 0x3b) return false;
    if (marker === 0x2c) {
      const descriptor = await read(offset, 10);
      if (++frames > 1) return true;
      const packed = descriptor[9];
      offset += 10 + (packed & 0x80 ? 3 * 2 ** ((packed & 7) + 1) : 0);
      await read(offset, 1);
      offset++;
    } else if (marker === 0x21) {
      offset += 2;
    } else {
      throw new Error('Invalid GIF block');
    }
    while (true) {
      const length = (await read(offset, 1))[0];
      offset += 1 + length;
      if (length === 0) break;
    }
  }
}

async function isAnimatedWebp(read, size) {
  let offset = 12;
  while (offset < size) {
    const chunk = await read(offset, 8);
    const type = textAt(chunk, 0, 4);
    const length = new DataView(chunk.buffer, chunk.byteOffset, 8).getUint32(4, true);
    if (offset + 8 + length > size) throw new Error('Truncated WebP chunk');
    if (type === 'ANIM' || type === 'ANMF') return true;
    if (type === 'VP8X' && length >= 1 && ((await read(offset + 8, 1))[0] & 0x02)) {
      return true;
    }
    offset += 8 + length + (length % 2);
  }
  return false;
}

async function isAnimatedPng(read, size) {
  let offset = 8;
  while (offset < size) {
    const chunk = await read(offset, 8);
    const type = textAt(chunk, 4, 4);
    const length = new DataView(chunk.buffer, chunk.byteOffset, 8).getUint32(0);
    if (offset + 12 + length > size) throw new Error('Truncated PNG chunk');
    if (type === 'acTL' && length === 8) {
      const control = await read(offset + 8, 4);
      return new DataView(control.buffer, control.byteOffset, 4).getUint32(0) > 1;
    }
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

export async function isAnimatedImage(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const type = (file.type || '').toLowerCase();
  const possible =
    ['image/gif', 'image/webp', 'image/png', 'image/apng'].includes(type) ||
    ['gif', 'webp', 'png', 'apng'].includes(ext);
  if (!possible) return false;
  try {
    const read = createReader(file);
    const header = await read(0, Math.min(12, file.size));
    const sig = textAt(header, 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return await isAnimatedGif(read);
    if (textAt(header, 0, 4) === 'RIFF' && textAt(header, 8, 4) === 'WEBP') {
      return await isAnimatedWebp(read, file.size);
    }
    if (textAt(header, 0, 8) === '\x89PNG\r\n\x1a\n') {
      return await isAnimatedPng(read, file.size);
    }
    return possible;
  } catch {
    return true;
  }
}

