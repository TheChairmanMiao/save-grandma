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

/** Serve the existing Vite output byte-for-byte from a single self-contained Worker. */
export function serveAsset(request: Request, assets: Record<string, EmbeddedAsset>): Response {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return securityHeaders(new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD', 'Cache-Control': 'no-store' } }));
  }
  const pathname = new URL(request.url).pathname;
  const key = pathname === '/' ? '/index.html' : pathname;
  const asset = Object.hasOwn(assets, key) ? assets[key] : undefined;
  if (!asset) {
    return securityHeaders(new Response(method === 'HEAD' ? null : 'Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } }));
  }
  const headers = new Headers({
    'Content-Type': asset.contentType,
    'Cache-Control': key === '/index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    ETag: asset.etag,
  });
  const matches = request.headers.get('If-None-Match')?.split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag === asset.etag || tag === `W/${asset.etag}`;
  });
  if (matches) return securityHeaders(new Response(null, { status: 304, headers }));
  headers.set('Content-Length', String(asset.byteLength));
  if (method === 'HEAD') return securityHeaders(new Response(null, { headers }));
  if (asset.encoding === 'utf8') return securityHeaders(new Response(asset.body, { headers }));
  const binary = atob(asset.body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return securityHeaders(new Response(bytes, { headers }));
}
