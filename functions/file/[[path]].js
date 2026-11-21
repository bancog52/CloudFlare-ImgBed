function buildHeaders(mimeType, fileName) {
  const headers = new Headers();
  headers.set('Content-Type', mimeType || 'application/octet-stream');
  headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  const safeName = encodeURIComponent(fileName || 'image');
  headers.set('Content-Disposition', `inline; filename*=UTF-8''${safeName}`);
  return headers;
}

export async function onRequestGet({ env, params }) {
  const pathParts = Array.isArray(params.path) ? params.path : [params.path];
  const rawId = pathParts.filter(Boolean).join('/');
  if (!rawId) return new Response('Not Found', { status: 404 });

  let id = rawId;
  try {
    id = pathParts.filter(Boolean).map((p) => decodeURIComponent(p)).join('/');
  } catch {
    id = rawId;
  }

  if (!env.img_r2) {
    return new Response('R2 bucket is not bound', { status: 500 });
  }

  let obj = await env.img_r2.get(id);
  if (!obj && id !== rawId) {
    obj = await env.img_r2.get(rawId);
  }
  if (!obj) {
    return new Response('Not Found', { status: 404 });
  }

  const fileName = id.split('/').pop() || 'image';
  const headers = buildHeaders(obj.httpMetadata?.contentType, fileName);
  if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
  headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { status: 200, headers });
}
