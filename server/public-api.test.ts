import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { cleanupExpiredSessions, DAILY_SESSION_LIMIT, handlePublicApi, SESSION_LEASE_MS, type DemoDatabase, type D1Statement, type PublicApiEnv } from './public-api';

class SqliteD1 implements DemoDatabase {
  readonly sql = new DatabaseSync(':memory:');
  constructor() { this.sql.exec(readFileSync(new URL('./schema.sql', import.meta.url), 'utf8')); }
  prepare(query: string): D1Statement {
    const statement = this.sql.prepare(query);
    let values: (string | number | null)[] = [];
    const prepared: D1Statement = {
      bind: (...bound) => { values = bound; return prepared; },
      first: async <T>() => (statement.get(...values) ?? null) as T | null,
      run: async () => statement.run(...values),
    };
    return prepared;
  }
}
const ORIGIN = 'https://demo.example';
const OFFER = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const ANSWER = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
let db: SqliteD1;
let env: PublicApiEnv;
let fetcher: ReturnType<typeof vi.fn<typeof fetch>>;
let callSerial = 0;
function request(path: string, token?: string, sdp?: string, origin = ORIGIN) {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST', headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(sdp === undefined ? {} : { 'Content-Type': 'application/sdp' }) }, body: sdp,
  });
}
async function bootstrap() {
  const response = (await handlePublicApi(request('/api/realtime-token'), env))!;
  return { response, body: await response.json() as { value: string; relay: boolean; code?: string; remaining: number } };
}
async function createCall(token: string) { return (await handlePublicApi(request('/api/realtime-call', token, OFFER), env))!; }
async function closeCall(token: string) { return (await handlePublicApi(request('/api/realtime-close', token), env))!; }
const control = () => db.sql.prepare('SELECT * FROM demo_ai_control WHERE id=1').get()!;
const upstreamCreates = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/realtime/calls'));
const upstreamCloses = () => fetcher.mock.calls.filter(([url]) => String(url).endsWith('/hangup'));
const successfulCreate = () => new Response(ANSWER, { status: 201, headers: { Location: `https://api.openai.com/v1/realtime/calls/rtc_${++callSerial}` } });

beforeEach(() => {
  db = new SqliteD1(); env = { DEMO_DB: db, OPENAI_API_KEY: 'server-test-secret' }; callSerial = 0;
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-04T12:00:00Z'));
  fetcher = vi.fn<typeof fetch>(async url => String(url).endsWith('/hangup') ? new Response(null, { status: 200 }) : successfulCreate());
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { db.sql.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('durable public Realtime admissions', () => {
  it('atomically admits only one of many concurrent visitors', async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => bootstrap()));
    expect(responses.filter(item => item.response.ok)).toHaveLength(1);
    expect(responses.filter(item => item.body.code === 'BUSY')).toHaveLength(19);
    expect(control().admissions).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('enforces ten accepted reservations per UTC day, including abandoned reservations', async () => {
    for (let i = 0; i < DAILY_SESSION_LIMIT; i++) {
      const { response, body } = await bootstrap();
      expect(response.status).toBe(200); expect(body.remaining).toBe(9 - i);
      await closeCall(body.value);
    }
    const denied = await bootstrap();
    expect(denied.response.status).toBe(429); expect(denied.body.code).toBe('DAILY_LIMIT');
    expect(control().admissions).toBe(10);
    vi.setSystemTime(new Date('2026-11-05T00:00:00Z'));
    expect((await bootstrap()).response.status).toBe(200);
    expect(control().admissions).toBe(1);
  });

  it('does not reset concurrency when the UTC day changes', async () => {
    vi.setSystemTime(new Date('2026-11-04T23:59:30Z'));
    const { body } = await bootstrap(); await createCall(body.value);
    vi.setSystemTime(new Date('2026-11-05T00:00:01Z'));
    expect((await bootstrap()).body.code).toBe('BUSY');
    expect(control().admissions).toBe(1);
  });

  it('relays SDP using the server key, never a reusable provider key in the browser', async () => {
    const { body } = await bootstrap();
    expect(body.value).toMatch(/^ek_demo_[A-Za-z0-9_-]{43}$/);
    expect(body.value).not.toContain(env.OPENAI_API_KEY);
    expect(control().token_hash).not.toBe(body.value);
    expect(body.relay).toBe(true);
    const response = await createCall(body.value);
    expect(response.status).toBe(201); expect(await response.text()).toBe(ANSWER);
    expect(response.headers.get('Location')).toBeNull();
    expect(control().call_id).toBe('rtc_1');
    const init = upstreamCreates()[0][1]!;
    expect(new Headers(init.headers).get('Authorization')).toBe(`Bearer ${env.OPENAI_API_KEY}`);
    expect(init.body).toBeInstanceOf(FormData);
    const session = JSON.parse((init.body as FormData).get('session') as string);
    expect(session.model).toBe('gpt-realtime-2.1-mini');
    expect(session.audio.input.turn_detection).toMatchObject({ create_response: false, interrupt_response: false });
    expect(JSON.stringify(body)).not.toContain('server-test-secret');
  });

  it('consumes an opaque token only once, even for concurrent SDP submissions', async () => {
    const { body } = await bootstrap();
    const responses = await Promise.all([createCall(body.value), createCall(body.value)]);
    expect(responses.map(result => result.status).sort()).toEqual([201, 409]);
    expect(upstreamCreates()).toHaveLength(1);
  });

  it('rejects cross-origin writes, missing ownership, and oversized SDP before contacting the provider', async () => {
    const crossOrigin = (await handlePublicApi(request('/api/realtime-token', undefined, undefined, 'https://attacker.example'), env))!;
    expect(crossOrigin.status).toBe(403);
    const { body } = await bootstrap();
    expect((await createCall('ek_demo_' + 'x'.repeat(43))).status).toBe(409);
    expect((await handlePublicApi(request('/api/realtime-call', body.value, 'v=0\nm=audio\n' + 'a'.repeat(70_000)), env))!.status).toBe(400);
    expect((await handlePublicApi(request('/api/realtime-call', undefined, OFFER), env))!.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
    expect(control().state).toBe('reserved');
  });

  it('cannot close another visitor’s call with a different opaque token', async () => {
    const { body } = await bootstrap(); await createCall(body.value);
    await closeCall('ek_demo_' + 'x'.repeat(43));
    expect(control().state).toBe('active'); expect(upstreamCloses()).toHaveLength(0);
  });

  it('counts a provider-rejected attempt but releases its concurrency slot', async () => {
    fetcher.mockResolvedValueOnce(new Response('provider-secret-error-must-not-leak', { status: 429 }));
    const { body } = await bootstrap();
    const failed = await createCall(body.value);
    expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('provider-secret-error');
    expect(control().state).toBe('idle'); expect(control().admissions).toBe(1);
    expect((await bootstrap()).response.status).toBe(200); expect(control().admissions).toBe(2);
  });

  it('marks close during upstream setup and hangs up the accepted call before returning an answer', async () => {
    let finish!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const { body } = await bootstrap(); const connecting = createCall(body.value);
    await vi.waitFor(() => expect(upstreamCreates()).toHaveLength(1));
    const close = await closeCall(body.value);
    expect(close.status).toBe(202); expect(control().close_requested).toBe(1);
    expect((await bootstrap()).body.code).toBe('BUSY');
    finish(successfulCreate());
    expect((await connecting).status).toBe(409);
    expect(upstreamCloses()).toHaveLength(1); expect(control().state).toBe('idle');
  });

  it('expires unused reservations without contacting the provider', async () => {
    await bootstrap(); vi.advanceTimersByTime(60_001);
    expect((await bootstrap()).response.status).toBe(200);
    expect(control().admissions).toBe(2); expect(fetcher).not.toHaveBeenCalled();
  });

  it('hangs up an expired known call before allowing another reservation', async () => {
    const { body } = await bootstrap(); await createCall(body.value);
    vi.advanceTimersByTime(SESSION_LEASE_MS + 1);
    expect((await bootstrap()).response.status).toBe(200);
    expect(upstreamCloses()).toHaveLength(1); expect(control().state).toBe('reserved');
  });

  it('retains the concurrency gate until a failed hangup is confirmed on retry', async () => {
    const { body } = await bootstrap(); await createCall(body.value);
    fetcher.mockResolvedValue(new Response(null, { status: 503 }));
    expect((await closeCall(body.value)).status).toBe(503);
    expect((await bootstrap()).body.code).toBe('BUSY');
    expect(control().state).toBe('closing'); expect(control().admissions).toBe(1);
    fetcher.mockResolvedValue(new Response(null, { status: 404 }));
    expect((await bootstrap()).response.status).toBe(200);
    expect(control().admissions).toBe(2);
  });

  it('does not let a late close acknowledgement clear a newer visitor’s reservation', async () => {
    const { body } = await bootstrap(); await createCall(body.value);
    let finishClose!: (response: Response) => void;
    fetcher.mockReturnValueOnce(new Promise(resolve => { finishClose = resolve; }));
    const closing = closeCall(body.value);
    await vi.waitFor(() => expect(upstreamCloses()).toHaveLength(1));
    // Another request confirms that same old call is gone, then atomically admits the next visitor.
    const next = await bootstrap();
    expect(next.response.status).toBe(200);
    const newOwner = control().token_hash;
    finishClose(new Response(null, { status: 200 }));
    expect((await closing).status).toBe(200);
    expect(control().state).toBe('reserved');
    expect(control().token_hash).toBe(newOwner);
    expect(control().admissions).toBe(2);
  });

  it('bounds a stalled provider connection and retains its uncertain admission', async () => {
    fetcher.mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const { body } = await bootstrap(); const connecting = createCall(body.value);
    await vi.waitFor(() => expect(upstreamCreates()).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(20_000);
    expect((await connecting).status).toBe(503);
    expect(control().state).toBe('unknown');
    expect((await bootstrap()).body.code).toBe('BUSY');
    expect(control().admissions).toBe(1);
  });

  it('fails closed when upstream creation has an unknown network outcome', async () => {
    fetcher.mockRejectedValueOnce(new TypeError('connection lost'));
    const { body } = await bootstrap();
    expect((await createCall(body.value)).status).toBe(503);
    expect(control().state).toBe('unknown');
    vi.advanceTimersByTime(SESSION_LEASE_MS + 1);
    expect((await bootstrap()).body.code).toBe('BUSY');
    expect(control().admissions).toBe(1); expect(upstreamCreates()).toHaveLength(1);
  });

  it('fails closed if the provider accepts but omits the call ID', async () => {
    fetcher.mockResolvedValueOnce(new Response(ANSWER, { status: 201 }));
    const { body } = await bootstrap();
    expect((await createCall(body.value)).status).toBe(503);
    expect(control().state).toBe('unknown'); expect((await bootstrap()).body.code).toBe('BUSY');
  });

  it('returns sanitized errors for missing configuration or asynchronous database failures', async () => {
    expect((await handlePublicApi(request('/api/realtime-token'), { DEMO_DB: db }))!.status).toBe(503);
    const broken: DemoDatabase = { prepare: () => { throw new Error('sensitive-database-details'); } };
    const response = (await handlePublicApi(request('/api/realtime-token'), { ...env, DEMO_DB: broken }))!;
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('sensitive-database');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('reports public availability without consuming a reservation and falls through for the game', async () => {
    const status = (await handlePublicApi(new Request(`${ORIGIN}/api/realtime-status`), env))!;
    expect(await status.json()).toMatchObject({ available: true, remaining: 10, busy: false });
    expect(control().admissions).toBe(0);
    expect(await handlePublicApi(new Request(`${ORIGIN}/`), env)).toBeNull();
    expect(await cleanupExpiredSessions(env)).toEqual({ closed: false, blocked: false });
  });
});
