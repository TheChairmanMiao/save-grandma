export type EmbeddedAsset = {
  contentType: string;
  byteLength: number;
  etag: string;
  encoding: 'utf8' | 'base64';
  body: string;
};

export function securityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function assetBytes(asset: EmbeddedAsset): Uint8Array<ArrayBuffer> {
  if (asset.encoding === 'utf8') return new TextEncoder().encode(asset.body);
  const binary = atob(asset.body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function byteRange(value: string, total: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || total <= 0) return undefined;
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if ((first !== undefined && !Number.isSafeInteger(first)) || (last !== undefined && !Number.isSafeInteger(last))) return undefined;
  if (first === undefined) return last && last > 0 ? { start: Math.max(0, total - last), end: total - 1 } : undefined;
  if (first >= total || (last !== undefined && last < first)) return undefined;
  return { start: first, end: Math.min(last ?? total - 1, total - 1) };
}

/** Serve the existing Vite output byte-for-byte from a single self-contained Worker. */
export function serveAsset(request: Request, assets: Record<string, EmbeddedAsset>): Response {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return securityHeaders(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } }));
  }
  const pathname = new URL(request.url).pathname;
  const key = pathname === '/' ? '/index.html'
    : pathname === '/auditions' || pathname === '/auditions/' ? '/auditions/index.html' : pathname;
  const asset = Object.hasOwn(assets, key) ? assets[key] : undefined;
  if (!asset) {
    return securityHeaders(new Response(method === 'HEAD' ? null : 'Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }));
  }
  const headers = new Headers({
    'Content-Type': asset.contentType,
    'Cache-Control': key.endsWith('.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    ETag: asset.etag,
  });
  const audio = asset.contentType.startsWith('audio/');
  if (audio) headers.set('Accept-Ranges', 'bytes');
  const matches = request.headers.get('If-None-Match')?.split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag === asset.etag || tag === `W/${asset.etag}`;
  });
  if (matches) return securityHeaders(new Response(null, { status: 304, headers }));
  headers.set('Content-Length', String(asset.byteLength));
  if (method === 'HEAD') return securityHeaders(new Response(null, { headers }));
  const requestedRange = request.headers.get('Range');
  const ifRange = request.headers.get('If-Range');
  if (audio && requestedRange && (!ifRange || ifRange === asset.etag)) {
    const range = byteRange(requestedRange, asset.byteLength);
    if (!range) {
      headers.set('Content-Range', `bytes */${asset.byteLength}`);
      headers.set('Content-Length', '0');
      headers.set('Cache-Control', 'no-store');
      return securityHeaders(new Response(null, { status: 416, headers }));
    }
    headers.set('Content-Range', `bytes ${range.start}-${range.end}/${asset.byteLength}`);
    headers.set('Content-Length', String(range.end - range.start + 1));
    return securityHeaders(new Response(assetBytes(asset).slice(range.start, range.end + 1), { status: 206, headers }));
  }
  if (asset.encoding === 'utf8') return securityHeaders(new Response(asset.body, { headers }));
  return securityHeaders(new Response(assetBytes(asset), { headers }));
}
