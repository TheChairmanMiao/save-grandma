import { describe, expect, it } from 'vitest';
import { serveAsset, type EmbeddedAsset } from './assets';

const fixture = (body: string, contentType: string, encoding: 'utf8' | 'base64' = 'utf8'): EmbeddedAsset => ({
  body, contentType, encoding, byteLength: encoding === 'utf8' ? new TextEncoder().encode(body).length : atob(body).length, etag: '"fixture"',
});
const assets = {
  '/index.html': fixture('<!doctype html><title>Save Grandma</title>', 'text/html; charset=utf-8'),
  '/assets/game-123.js': fixture('console.log("Grandma’s ready");', 'text/javascript; charset=utf-8'),
  '/assets/pixel-123.png': fixture('AAEC/w==', 'image/png', 'base64'),
};
const request = (pathname: string, init?: RequestInit) => new Request(`https://demo.test${pathname}`, init);

describe('embedded Site assets', () => {
  it('serves the client entry at the original root URL with revalidation and security headers', async () => {
    const response = serveAsset(request('/?from=portfolio'), assets);
    expect(await response.text()).toBe(assets['/index.html'].body);
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Permissions-Policy')).toContain('microphone=(self)');
  });
  it('preserves UTF-8 client code and caches fingerprinted assets', async () => {
    const response = serveAsset(request('/assets/game-123.js'), assets);
    expect(await response.text()).toBe(assets['/assets/game-123.js'].body);
    expect(response.headers.get('Cache-Control')).toContain('immutable');
    expect(response.headers.get('Content-Length')).toBe(String(assets['/assets/game-123.js'].byteLength));
  });
  it('decodes binary image bytes without changing them', async () => {
    const response = serveAsset(request('/assets/pixel-123.png'), assets);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 255]));
    expect(response.headers.get('Content-Type')).toBe('image/png');
  });
  it('supports HEAD without returning the asset body', async () => {
    const response = serveAsset(request('/assets/game-123.js', { method: 'HEAD' }), assets);
    expect(await response.text()).toBe('');
    expect(response.headers.get('Content-Length')).toBe(String(assets['/assets/game-123.js'].byteLength));
  });
  it('revalidates matching strong or weak cache validators', async () => {
    for (const validator of ['"fixture"', 'W/"fixture"', '"older", "fixture"']) {
      const response = serveAsset(request('/assets/game-123.js', { headers: { 'If-None-Match': validator } }), assets);
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
    }
  });
  it('returns a non-cacheable 404 instead of client HTML for missing assets or API paths', async () => {
    for (const pathname of ['/assets/missing.js', '/api/unknown', '/toString']) {
      const response = serveAsset(request(pathname), assets);
      expect(response.status).toBe(404);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      expect(await response.text()).not.toContain('<!doctype');
    }
  });
  it('rejects write methods on static routes', async () => {
    const response = serveAsset(request('/', { method: 'POST' }), assets);
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('GET, HEAD');
    expect(response.headers.get('Cache-Control')).toBe('no-store');
  });
});
