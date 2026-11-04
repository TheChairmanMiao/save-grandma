import assets from 'virtual:save-grandma-assets';
import { handlePublicApi } from '../server/public-api';
import { securityHeaders, serveAsset } from './assets';

type Env = Parameters<typeof handlePublicApi>[1];
type Context = Parameters<typeof handlePublicApi>[2];

export default {
  async fetch(request: Request, env: Env, ctx: Context): Promise<Response> {
    try {
      const response = await handlePublicApi(request, env, ctx);
      if (response) {
        const headers = new Headers(response.headers);
        headers.set('Cache-Control', 'no-store');
        return securityHeaders(new Response(response.body, { status: response.status, statusText: response.statusText, headers }));
      }
      const pathname = new URL(request.url).pathname;
      if (pathname === '/api' || pathname.startsWith('/api/')) {
        return securityHeaders(Response.json({ error: 'Not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } }));
      }
      return serveAsset(request, assets);
    } catch {
      console.error('The demo Worker could not complete a request.');
      return securityHeaders(Response.json({ error: 'The demo is temporarily unavailable.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }));
    }
  },
};
