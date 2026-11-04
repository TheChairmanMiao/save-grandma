import { GRANDMA_SPEED, GRANDMA_VOICE, REALTIME_MODEL } from '../src/voice/model';

export const DAILY_SESSION_LIMIT = 10;
export const SESSION_LEASE_MS = 6 * 60_000;
const RESERVATION_MS = 60_000;
const MAX_SDP_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 20_000;
const OPENAI_CALLS = 'https://api.openai.com/v1/realtime/calls';
const TOKEN_FORMAT = /^ek_demo_[A-Za-z0-9_-]{43}$/;

type D1Value = string | number | null;
export interface D1Statement {
  bind(...values: D1Value[]): D1Statement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}
export interface DemoDatabase {
  prepare(sql: string): D1Statement;
  withSession?(constraint: 'first-primary'): DemoDatabase;
}
export interface PublicApiEnv {
  OPENAI_API_KEY?: string;
  DEMO_DB?: DemoDatabase;
}
export interface PublicApiContext { waitUntil(promise: Promise<unknown>): void }
type Control = {
  id: number; quota_day: string; admissions: number; token_hash: string | null;
  state: 'idle' | 'reserved' | 'connecting' | 'active' | 'closing' | 'unknown';
  call_id: string | null; expires_at: number; close_requested: number; created_at: number;
};
export type CleanupResult = { closed: boolean; blocked: boolean };

const database = (env: PublicApiEnv) => {
  if (!env.DEMO_DB) throw new Error('Demo database is not configured.');
  return env.DEMO_DB.withSession?.('first-primary') ?? env.DEMO_DB;
};
const json = (status: number, body: object, extra?: HeadersInit) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
});
const problem = (status: number, code: string, error: string, extra?: HeadersInit) => json(status, { error, code }, extra);
const unavailable = () => problem(503, 'AI_UNAVAILABLE', 'Natural voice is unavailable right now. You can keep playing offline.');
const utcDay = (now: number) => new Date(now).toISOString().slice(0, 10);
const readControl = (db: DemoDatabase) => db.prepare('SELECT * FROM demo_ai_control WHERE id = 1').first<Control>();
const initialize = (db: DemoDatabase) => db.prepare('INSERT OR IGNORE INTO demo_ai_control (id) VALUES (1)').run();

function newToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = ''; bytes.forEach(byte => { binary += String.fromCharCode(byte); });
  return `ek_demo_${btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')}`;
}
async function hashToken(token: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function requestOwner(request: Request) {
  const token = request.headers.get('Authorization')?.match(/^Bearer (\S+)$/)?.[1];
  return token && TOKEN_FORMAT.test(token) ? hashToken(token) : null;
}
function sameOrigin(request: Request) {
  return request.headers.get('Origin') === new URL(request.url).origin
    && !['cross-site', 'same-site'].includes(request.headers.get('Sec-Fetch-Site') ?? '');
}
async function readSdp(request: Request | Response) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing SDP.');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > MAX_SDP_BYTES) { await reader.cancel(); throw new Error('SDP is too large.'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes); let offset = 0;
  chunks.forEach(chunk => { body.set(chunk, offset); offset += chunk.byteLength; });
  const sdp = new TextDecoder().decode(body);
  if (!sdp.startsWith('v=0') || !sdp.includes('m=audio')) throw new Error('Invalid SDP.');
  return sdp;
}
async function providerFetch(url: string, init: RequestInit) {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fetch(url, { ...init, signal: abort.signal }),
      new Promise<Response>((_resolve, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error('Provider request timed out.')); }, UPSTREAM_TIMEOUT_MS);
      }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}
function providerCallId(response: Response) {
  const location = response.headers.get('Location');
  if (!location) return null;
  try {
    const url = new URL(location, 'https://api.openai.com');
    const match = url.pathname.match(/^\/v1\/realtime\/calls\/([A-Za-z0-9_-]{1,200})$/);
    return url.origin === 'https://api.openai.com' && match ? match[1] : null;
  } catch { return null; }
}
async function release(db: DemoDatabase, owner: string, callId?: string) {
  // Scope every completion to its original token: a late close must never clear a newer reservation.
  await db.prepare(`UPDATE demo_ai_control SET state='idle', token_hash=NULL, call_id=NULL,
    expires_at=0, close_requested=0, created_at=0 WHERE id=1 AND token_hash=?1
    ${callId ? 'AND call_id=?2' : ''}`).bind(...(callId ? [owner, callId] : [owner])).run();
}
async function endCall(db: DemoDatabase, env: PublicApiEnv, control: Control): Promise<CleanupResult> {
  if (!control.token_hash || !control.call_id || !env.OPENAI_API_KEY) return { closed: false, blocked: control.state !== 'idle' };
  await db.prepare("UPDATE demo_ai_control SET state='closing', close_requested=1 WHERE id=1 AND token_hash=?1 AND call_id=?2")
    .bind(control.token_hash, control.call_id).run();
  try {
    const result = await providerFetch(`${OPENAI_CALLS}/${encodeURIComponent(control.call_id)}/hangup`, {
      method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    });
    // A known call ID returning 404 is already gone. Other failures retain the global lease.
    if (!result.ok && result.status !== 404) return { closed: false, blocked: true };
    // One opaque token can create only one provider call, even if persisting its ID previously failed.
    await release(db, control.token_hash);
    return { closed: true, blocked: false };
  } catch { return { closed: false, blocked: true }; }
}

/** Invoke from a scheduled handler when available; every API request also performs this cleanup. */
export async function cleanupExpiredSessions(env: PublicApiEnv, now = Date.now()): Promise<CleanupResult> {
  const db = database(env);
  await initialize(db);
  const control = await readControl(db);
  if (!control || control.state === 'idle') return { closed: false, blocked: false };
  if (control.state === 'reserved' && control.expires_at <= now) {
    await db.prepare("UPDATE demo_ai_control SET state='idle', token_hash=NULL, expires_at=0, close_requested=0, created_at=0 WHERE id=1 AND token_hash=?1 AND state='reserved' AND expires_at<=?2")
      .bind(control.token_hash, now).run();
    return { closed: true, blocked: (await readControl(db))?.state !== 'idle' };
  }
  if (control.call_id && (control.close_requested || control.expires_at <= now)) return endCall(db, env, control);
  if (control.state === 'connecting' && control.expires_at <= now) {
    // A worker could have stopped after creating a call but before saving its ID. Do not admit a second call.
    await db.prepare("UPDATE demo_ai_control SET state='unknown', close_requested=1 WHERE id=1 AND token_hash=?1 AND state='connecting' AND call_id IS NULL")
      .bind(control.token_hash).run();
  }
  return { closed: false, blocked: true };
}

async function reserve(request: Request, db: DemoDatabase) {
  if (request.headers.get('Content-Length') && Number(request.headers.get('Content-Length')) > 1024) return problem(413, 'INVALID_REQUEST', 'This request is too large.');
  const value = newToken(); const owner = await hashToken(value); const now = Date.now(); const day = utcDay(now);
  const admitted = await db.prepare(`UPDATE demo_ai_control SET quota_day=?1,
    admissions=CASE WHEN quota_day=?1 THEN admissions+1 ELSE 1 END,
    token_hash=?2, state='reserved', call_id=NULL, expires_at=?3, close_requested=0, created_at=?4
    WHERE id=1 AND state='idle' AND (quota_day<>?1 OR admissions<?5)
    RETURNING admissions, expires_at`)
    .bind(day, owner, now + RESERVATION_MS, now, DAILY_SESSION_LIMIT).first<{ admissions: number; expires_at: number }>();
  if (!admitted) {
    const control = await readControl(db);
    if (control?.quota_day === day && control.admissions >= DAILY_SESSION_LIMIT) return problem(429, 'DAILY_LIMIT', 'Today’s 10 natural-voice sessions have been used. You can keep playing offline.');
    return problem(409, 'BUSY', 'Someone is talking to Grandma. Try again shortly, or play offline.', { 'Retry-After': '30' });
  }
  return json(200, { value, relay: true, expires_at: Math.floor(admitted.expires_at / 1000), remaining: DAILY_SESSION_LIMIT - admitted.admissions });
}

async function relay(request: Request, env: PublicApiEnv, db: DemoDatabase) {
  const owner = await requestOwner(request);
  if (!owner) return problem(401, 'SESSION_INVALID', 'Start a new call before connecting.');
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/sdp') return problem(415, 'INVALID_SDP', 'The call needs an SDP offer.');
  let sdp: string;
  try { sdp = await readSdp(request); }
  catch { return problem(400, 'INVALID_SDP', 'The call’s connection offer is invalid or too large.'); }
  const now = Date.now();
  const control = await db.prepare(`UPDATE demo_ai_control SET state='connecting', expires_at=?2
    WHERE id=1 AND token_hash=?1 AND state='reserved' AND expires_at>?3 AND close_requested=0 RETURNING *`)
    .bind(owner, now + SESSION_LEASE_MS, now).first<Control>();
  if (!control) return problem(409, 'SESSION_USED', 'This call reservation has expired or was already used. Start a new call.');
  const form = new FormData(); form.set('sdp', sdp);
  form.set('session', JSON.stringify({
    type: 'realtime', model: REALTIME_MODEL, output_modalities: ['audio'],
    audio: {
      input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' }, turn_detection: { type: 'semantic_vad', eagerness: 'high', create_response: false, interrupt_response: false } },
      output: { voice: GRANDMA_VOICE, speed: GRANDMA_SPEED },
    },
  }));
  let response: Response;
  try {
    response = await providerFetch(OPENAI_CALLS, { method: 'POST', headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: form });
  } catch {
    // The provider might have accepted the call. An unknown result must not open another admission slot.
    await db.prepare("UPDATE demo_ai_control SET state='unknown', close_requested=1 WHERE id=1 AND token_hash=?1 AND state='connecting'").bind(owner).run();
    return problem(503, 'PROVIDER_UNCERTAIN', 'The AI call could not be confirmed. Natural voice is temporarily unavailable.');
  }
  if (!response.ok) { await release(db, owner); return problem(502, 'PROVIDER_UNAVAILABLE', 'Grandma’s AI could not connect. Try again later, or play offline.'); }
  const callId = providerCallId(response);
  if (!callId) {
    await db.prepare("UPDATE demo_ai_control SET state='unknown', close_requested=1 WHERE id=1 AND token_hash=?1").bind(owner).run();
    return problem(503, 'PROVIDER_UNCERTAIN', 'The AI call could not be confirmed. Natural voice is temporarily unavailable.');
  }
  let active: Control | null;
  try {
    active = await db.prepare("UPDATE demo_ai_control SET state='active', call_id=?2 WHERE id=1 AND token_hash=?1 AND state IN ('connecting','unknown') RETURNING *")
      .bind(owner, callId).first<Control>();
  } catch {
    await endCall(db, env, { ...control, call_id: callId });
    return unavailable();
  }
  if (!active) { await endCall(db, env, { ...control, call_id: callId }); return problem(409, 'SESSION_CLOSED', 'This call was closed before it connected.'); }
  if (active.close_requested || active.expires_at <= Date.now()) {
    await endCall(db, env, active);
    return problem(409, 'SESSION_CLOSED', 'This call was closed before it connected.');
  }
  let answer: string;
  try { answer = await readSdp(response); }
  catch { await endCall(db, env, active); return problem(502, 'PROVIDER_UNAVAILABLE', 'The AI call returned an invalid connection answer.'); }
  return new Response(answer, { status: 201, headers: { 'Content-Type': 'application/sdp', 'Cache-Control': 'no-store', 'X-Demo-Expires-At': String(active.expires_at) } });
}

async function close(request: Request, env: PublicApiEnv, db: DemoDatabase) {
  const owner = await requestOwner(request);
  if (!owner) return problem(401, 'SESSION_INVALID', 'This call cannot be closed with that authorization.');
  const control = await db.prepare('UPDATE demo_ai_control SET close_requested=1 WHERE id=1 AND token_hash=?1 RETURNING *').bind(owner).first<Control>();
  if (!control) return json(200, { closed: true }); // Idempotent close after cleanup or a previous close.
  if (control.state === 'reserved') {
    await db.prepare("UPDATE demo_ai_control SET state='idle', token_hash=NULL, expires_at=0, close_requested=0, created_at=0 WHERE id=1 AND token_hash=?1 AND state='reserved'").bind(owner).run();
    return json(200, { closed: true });
  }
  if (!control.call_id) return json(202, { closed: false, pending: true });
  const result = await endCall(db, env, control);
  return result.closed ? json(200, { closed: true }) : problem(503, 'CLOSE_PENDING', 'The AI call is still closing. Please wait before starting another.');
}

/** Same-origin API only. Unknown non-API paths fall through to the existing static app. */
export async function handlePublicApi(request: Request, env: PublicApiEnv, _ctx?: PublicApiContext): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/')) return null;
  const statusRoute = path === '/api/realtime-status' && request.method === 'GET';
  if (!statusRoute && !['/api/realtime-token', '/api/realtime-call', '/api/realtime-close'].includes(path)) return problem(404, 'NOT_FOUND', 'No API route exists here.');
  if (!statusRoute && request.method !== 'POST') return problem(405, 'METHOD_NOT_ALLOWED', 'Use POST for this call action.', { Allow: 'POST' });
  if (!statusRoute && !sameOrigin(request)) return problem(403, 'ORIGIN_REJECTED', 'This call must start from the demo website.');
  if (!env.OPENAI_API_KEY || !env.DEMO_DB) return unavailable();
  try {
    await cleanupExpiredSessions(env);
    const db = database(env);
    if (statusRoute) {
      const control = await readControl(db); const used = control?.quota_day === utcDay(Date.now()) ? control.admissions : 0;
      return json(200, { available: true, relay: true, dailyLimit: DAILY_SESSION_LIMIT, remaining: DAILY_SESSION_LIMIT - used, busy: control?.state !== 'idle', leaseSeconds: SESSION_LEASE_MS / 1000 });
    }
    if (path === '/api/realtime-token') return await reserve(request, db);
    if (path === '/api/realtime-call') return await relay(request, env, db);
    return await close(request, env, db);
  } catch { return unavailable(); }
}
