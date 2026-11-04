// Six paid recordings only with VOICE_COMPARISON=1. --check never loads a key or opens a network socket.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCRIPT = [
  'Sweetheart, the bathroom’s flooding, and I’m not buying waterfront property today.',
  'You said left. I turned right. Terrific. Now the sink’s having a nervous breakdown.',
  'Easy, kid. One thing at a time. I’m ornery, not waterproof.',
  'There. It stopped. You did good, sweetheart. Don’t let it go to your head.',
].join('\n');
export const VOICES = ['marin', 'coral', 'ballad'];
export const MODELS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1'];
const SAMPLE_RATE = 24_000;
const CHANNELS = 1;
const SAMPLE_BYTES = 2;
const SESSION_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_TOKENS = 1500;
const MAX_PCM_BYTES = SAMPLE_RATE * SAMPLE_BYTES * CHANNELS * 60;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIRECTORY = join(ROOT, 'artifacts', 'voice-comparison');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const words = text => text.normalize('NFKC').replace(/[’‘]/g, "'").toLowerCase().match(/[a-z0-9]+(?:'[a-z]+)*/g) ?? [];
const matchesScript = transcript => JSON.stringify(words(transcript)) === JSON.stringify(words(SCRIPT));
const filename = (voice, model) => `${voice}-${model.endsWith('-mini') ? 'mini' : 'full'}`;
const safeCode = value => typeof value === 'string' && /^[a-z0-9_.-]{1,80}$/i.test(value) ? value : undefined;

function numericUsage(value, depth = 0) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 5) return undefined;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-z_]{1,80}$/i.test(key)) continue;
    if (typeof item === 'number' && Number.isFinite(item) && item >= 0) result[key] = item;
    else if (item && typeof item === 'object' && !Array.isArray(item)) result[key] = numericUsage(item, depth + 1);
  }
  return result;
}

export function pcmToWav(pcm) {
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % SAMPLE_BYTES || pcm.length > MAX_PCM_BYTES) throw new Error('INVALID_PCM');
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22); header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * CHANNELS * SAMPLE_BYTES, 28);
  header.writeUInt16LE(CHANNELS * SAMPLE_BYTES, 32); header.writeUInt16LE(SAMPLE_BYTES * 8, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
export function validateWav(wav) {
  assert.ok(Buffer.isBuffer(wav) && wav.length > 44, 'INVALID_WAV');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF', 'INVALID_WAV');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE', 'INVALID_WAV');
  assert.equal(wav.readUInt32LE(4), wav.length - 8, 'INVALID_WAV');
  assert.equal(wav.readUInt16LE(20), 1, 'INVALID_WAV');
  assert.equal(wav.readUInt16LE(22), CHANNELS, 'INVALID_WAV');
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE, 'INVALID_WAV');
  assert.equal(wav.readUInt16LE(34), 16, 'INVALID_WAV');
  assert.equal(wav.toString('ascii', 36, 40), 'data', 'INVALID_WAV');
  assert.equal(wav.readUInt32LE(40), wav.length - 44, 'INVALID_WAV');
  assert.ok((wav.length - 44) % 2 === 0 && wav.length - 44 <= MAX_PCM_BYTES, 'INVALID_WAV');
  return (wav.length - 44) / (SAMPLE_RATE * CHANNELS * SAMPLE_BYTES);
}

async function loadPersona() {
  const path = join(ROOT, 'src', 'voice', 'persona.ts');
  const source = await readFile(path, 'utf8');
  // Use the already-installed Vite transformer so this also works on Node versions without native TS imports.
  const { transformWithEsbuild } = await import('vite');
  const transformed = await transformWithEsbuild(source, path, { loader: 'ts', format: 'esm', target: 'es2022' });
  const module = await import(`data:text/javascript;base64,${Buffer.from(transformed.code).toString('base64')}`);
  assert.equal(typeof module.GRANDMA_VOICE_STYLE, 'string', 'PERSONA_MISSING');
  assert.ok(module.GRANDMA_VOICE_STYLE.trim(), 'PERSONA_MISSING');
  return { text: module.GRANDMA_VOICE_STYLE, sourceHash: sha256(source) };
}
function sessionConfig(model, voice, persona) {
  return {
    type: 'realtime', model, output_modalities: ['audio'],
    instructions: `${persona}\nThis is a controlled voice audition. Read the supplied four-line script exactly, in order. Let the dry panic, mistaken action, affection, and relief in its meaning shape your acting. Use natural pauses between lines. Do not introduce, explain, paraphrase, add words, or read line numbers. Do not call tools.`,
    audio: {
      input: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, transcription: null, turn_detection: null },
      output: { format: { type: 'audio/pcm', rate: SAMPLE_RATE }, voice, speed: 1 },
    },
    reasoning: { effort: 'low' }, max_output_tokens: MAX_OUTPUT_TOKENS, tools: [], tool_choice: 'none',
  };
}
function acknowledgement(session) {
  const output = session?.audio?.output;
  return {
    model: safeCode(session?.model), voice: safeCode(output?.voice),
    speed: typeof output?.speed === 'number' ? output.speed : undefined,
    format: { type: output?.format?.type === 'audio/pcm' ? 'audio/pcm' : 'other', rate: output?.format?.rate },
    reasoningEffort: safeCode(session?.reasoning?.effort),
  };
}

/** Inject a fake Socket in --check. No automatic retries, alternative models, or fallback voices. */
export async function recordSample({ Socket, apiKey, model, voice, persona, signal, timeoutMs = SESSION_TIMEOUT_MS }) {
  assert.ok(MODELS.includes(model) && VOICES.includes(voice), 'UNSUPPORTED_PAIR');
  assert.ok(timeoutMs > 0 && timeoutMs <= SESSION_TIMEOUT_MS, 'INVALID_SESSION_BOUND');
  const began = Date.now();
  const chunks = []; let bytes = 0; let transcript = ''; let acknowledged;
  let responseId; let responseStatus; let usage; let requested = false; let configured = false;
  let socket;
  const result = await new Promise(resolveResult => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout); signal?.removeEventListener('abort', abort);
      // Raw provider messages are never copied: authentication errors can contain key fragments.
      resolveResult({ error, acknowledged, responseStatus, usage, transcript, pcm: Buffer.concat(chunks), elapsedMs: Date.now() - began });
    };
    const abort = () => finish({ code: 'INTERRUPTED' });
    const timeout = setTimeout(() => finish({ code: 'SESSION_TIMEOUT' }), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    try {
      socket = new Socket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        headers: { Authorization: `Bearer ${apiKey}` }, handshakeTimeout: 10_000,
        maxPayload: 256 * 1024, perMessageDeflate: false,
      });
      socket.on('error', () => finish({ code: 'SOCKET_ERROR' }));
      socket.on('unexpected-response', (_request, response) => {
        response.resume?.();
        finish({ code: 'HANDSHAKE_REJECTED', status: response.statusCode });
      });
      socket.on('close', () => { if (!settled) finish({ code: 'SOCKET_CLOSED_EARLY' }); });
      socket.on('message', raw => {
        if (settled) return;
        let event;
        try { event = JSON.parse(raw.toString()); }
        catch { finish({ code: 'INVALID_SERVER_EVENT' }); return; }
        try {
          if (event.type === 'error') { finish({ code: 'PROVIDER_ERROR', providerCode: safeCode(event.error?.code), providerType: safeCode(event.error?.type) }); return; }
          if (event.type === 'session.created' && !configured) {
            configured = true;
            socket.send(JSON.stringify({ type: 'session.update', session: sessionConfig(model, voice, persona) }));
          } else if (event.type === 'session.updated' && !requested) {
            acknowledged = acknowledgement(event.session);
            if (acknowledged.model !== model || acknowledged.voice !== voice || acknowledged.speed !== 1
                || acknowledged.format.type !== 'audio/pcm' || acknowledged.format.rate !== SAMPLE_RATE
                || acknowledged.reasoningEffort !== 'low') {
              finish({ code: 'SESSION_CONFIGURATION_MISMATCH' }); return;
            }
            requested = true;
            socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: SCRIPT }] } }));
            socket.send(JSON.stringify({ type: 'response.create' }));
          } else if (event.type === 'response.created') {
            if (!requested || responseId) { finish({ code: 'UNEXPECTED_RESPONSE' }); return; }
            responseId = event.response?.id;
          } else if (event.type === 'response.output_audio.delta') {
            if (!requested || !responseId || event.response_id !== responseId || typeof event.delta !== 'string'
                || !/^[A-Za-z0-9+/]*={0,2}$/.test(event.delta) || event.delta.length % 4) {
              finish({ code: 'INVALID_AUDIO_EVENT' }); return;
            }
            const audio = Buffer.from(event.delta, 'base64'); bytes += audio.length;
            if (bytes > MAX_PCM_BYTES) { finish({ code: 'AUDIO_LIMIT' }); return; }
            chunks.push(audio);
          } else if (event.type === 'response.output_audio_transcript.delta') {
            if (event.response_id === responseId && typeof event.delta === 'string') transcript += event.delta;
            if (transcript.length > 10_000) { finish({ code: 'TRANSCRIPT_LIMIT' }); return; }
          } else if (event.type === 'response.output_audio_transcript.done') {
            if (event.response_id === responseId && typeof event.transcript === 'string') transcript = event.transcript.slice(0, 10_000);
          } else if (event.type === 'response.done') {
            if (!requested || !responseId || event.response?.id !== responseId) { finish({ code: 'UNEXPECTED_RESPONSE' }); return; }
            responseStatus = safeCode(event.response.status);
            usage = numericUsage(event.response.usage);
            if (!transcript) transcript = (event.response.output ?? []).flatMap(item => item.content ?? []).map(content => content.transcript ?? '').join('\n').slice(0, 10_000);
            finish(responseStatus === 'completed' ? undefined : { code: 'RESPONSE_NOT_COMPLETED' });
          }
        } catch { finish({ code: 'SOCKET_EVENT_FAILED' }); }
      });
    } catch { finish({ code: 'SOCKET_SETUP_FAILED' }); }
  });
  // Always force socket teardown; do not leave a paid session waiting for an unbounded close handshake.
  if (socket) { try { socket.close(1000); } catch { /* Terminate below regardless. */ } finally { socket.terminate(); } }
  return result;
}

async function existingSample(base, expectedHash) {
  let metadata;
  try { metadata = JSON.parse(await readFile(`${base}.json`, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('EXISTING_METADATA_INVALID');
    try { await readFile(`${base}.attempt.json`); throw new Error('PREVIOUS_SAMPLE_ATTEMPT_NEEDS_REVIEW'); }
    catch (attemptError) { if (attemptError.code !== 'ENOENT') throw attemptError; }
    try { await readFile(`${base}.wav`); throw new Error('EXISTING_UNREVIEWED_AUDIO'); }
    catch (wavError) { if (wavError.code !== 'ENOENT') throw wavError; }
    return null;
  }
  if (!metadata.complete || metadata.configHash !== expectedHash) throw new Error('EXISTING_SAMPLE_NEEDS_REVIEW');
  const wav = await readFile(`${base}.wav`);
  validateWav(wav);
  return metadata;
}

async function offlineCheck() {
  assert.equal(words(SCRIPT).length, 50);
  assert.equal(SCRIPT.split('\n').length, 4);
  assert.equal(new Set(VOICES.flatMap(voice => MODELS.map(model => `${voice}/${model}`))).size, 6);
  assert.equal(matchesScript(SCRIPT.replaceAll('’', "'")), true);
  const wav = pcmToWav(Buffer.alloc(48_000));
  assert.equal(validateWav(wav), 1);
  assert.throws(() => pcmToWav(Buffer.alloc(0)), /INVALID_PCM/);
  assert.throws(() => pcmToWav(Buffer.alloc(3)), /INVALID_PCM/);
  assert.throws(() => pcmToWav(Buffer.alloc(MAX_PCM_BYTES + 2)), /INVALID_PCM/);
  assert.throws(() => validateWav(Buffer.from('not a WAV')), /INVALID_WAV/);
  assert.deepEqual(numericUsage({ input_tokens: 10, output_tokens: 20, error: 'never-copy-raw-errors', nested: { cached_tokens: 2 } }), { input_tokens: 10, output_tokens: 20, nested: { cached_tokens: 2 } });
  class FakeSocket {
    handlers = new Map(); sent = []; terminated = false;
    constructor() { queueMicrotask(() => this.emit({ type: 'session.created' })); }
    on(name, callback) { this.handlers.set(name, callback); }
    emit(event) { this.handlers.get('message')?.(Buffer.from(JSON.stringify(event))); }
    send(text) {
      const event = JSON.parse(text); this.sent.push(event);
      if (event.type === 'session.update') {
        assert.equal(event.session.max_output_tokens, 1500);
        assert.equal(event.session.audio.input.turn_detection, null);
        queueMicrotask(() => this.emit({ type: 'session.updated', session: event.session }));
      }
      if (event.type === 'response.create') {
        this.emit({ type: 'response.created', response: { id: 'offline-response' } });
        this.emit({ type: 'response.output_audio.delta', response_id: 'offline-response', delta: Buffer.alloc(48_000).toString('base64') });
        this.emit({ type: 'response.output_audio_transcript.done', response_id: 'offline-response', transcript: SCRIPT });
        this.emit({ type: 'response.done', response: { id: 'offline-response', status: 'completed', usage: { total_tokens: 123 } } });
      }
    }
    close() {}
    terminate() { this.terminated = true; }
  }
  let instance;
  class TrackingSocket extends FakeSocket { constructor(...args) { super(...args); instance = this; } }
  const sample = await recordSample({ Socket: TrackingSocket, apiKey: 'offline-dummy', model: MODELS[0], voice: VOICES[0], persona: 'Offline test persona.' });
  assert.equal(sample.error, undefined); assert.equal(sample.responseStatus, 'completed');
  assert.equal(matchesScript(sample.transcript), true); assert.equal(instance.terminated, true);
  assert.equal(instance.sent.filter(event => event.type === 'response.create').length, 1);
  assert.equal(validateWav(pcmToWav(sample.pcm)), 1);
  const persona = await loadPersona(); assert.ok(persona.text.length > 20);
  const checkDirectory = await mkdtemp(join(tmpdir(), 'grandma-comparison-check-'));
  try {
    const base = join(checkDirectory, 'sample');
    await writeFile(`${base}.attempt.json`, '{}');
    await assert.rejects(existingSample(base, 'offline'), /PREVIOUS_SAMPLE_ATTEMPT_NEEDS_REVIEW/);
    await writeFile(`${base}.json`, JSON.stringify({ complete: true, configHash: 'offline' }));
    await writeFile(`${base}.wav`, wav);
    assert.equal((await existingSample(base, 'offline')).complete, true);
  } finally { await rm(checkDirectory, { recursive: true, force: true }); }
  await import('ws');
  console.log('Voice comparison offline checks passed: six unique pairs, identical50-word script,1500-token bound, acknowledged native PCM, one response, WAV guards, forced socket cleanup, and sanitized usage. No key loaded or network/provider calls made.');
}

async function main() {
  if (process.argv.length > 2) {
    if (process.argv.length !== 3 || process.argv[2] !== '--check') throw new Error('ONLY_CHECK_ARGUMENT_SUPPORTED');
    await offlineCheck(); return;
  }
  if (process.env.VOICE_COMPARISON !== '1') throw new Error('EXPLICIT_VOICE_COMPARISON_OPT_IN_REQUIRED');
  const { loadEnv } = await import('vite');
  const settings = loadEnv('development', ROOT, '');
  const apiKey = settings.OPENAI_API_KEY;
  if (!apiKey?.trim()) throw new Error('OPENAI_API_KEY_NOT_CONFIGURED');
  const { default: Socket } = await import('ws');
  const persona = await loadPersona();
  await mkdir(DIRECTORY, { recursive: true });
  const lockPath = join(DIRECTORY, '.run.lock');
  const lock = await open(lockPath, 'wx').catch(() => { throw new Error('COMPARISON_ALREADY_LOCKED_INSPECT_BEFORE_RETRY'); });
  const abort = new AbortController();
  const interrupt = () => abort.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    const clips = [];
    for (const voice of VOICES) for (const model of MODELS) {
      if (abort.signal.aborted) throw new Error('INTERRUPTED');
      const name = filename(voice, model); const base = join(DIRECTORY, name);
      const configHash = sha256(JSON.stringify({ model, voice, speed: 1, script: SCRIPT, personaHash: persona.sourceHash, maxOutputTokens: MAX_OUTPUT_TOKENS, reasoning: 'low', sampleRate: SAMPLE_RATE }));
      const existing = await existingSample(base, configHash);
      if (existing) console.log(`Reusing completed ${name}; no provider request.`);
      else {
        // Persist before the paid request. A later write failure must not silently permit another call.
        await writeFile(`${base}.attempt.json`, JSON.stringify({ model, voice, configHash, startedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
        console.log(`Recording ${name} (${clips.length + 1}/6), at most60seconds; one request, no retry.`);
        const sample = await recordSample({ Socket, apiKey, model, voice, persona: persona.text, signal: abort.signal });
        const scriptMatched = matchesScript(sample.transcript);
        let wav;
        if (sample.pcm.length && sample.pcm.length % 2 === 0) wav = pcmToWav(sample.pcm);
        const complete = !sample.error && sample.responseStatus === 'completed' && !!wav && scriptMatched;
        const metadata = {
          complete, model, voice, speed: 1, script: SCRIPT, scriptWordCount: words(SCRIPT).length,
          personaHash: persona.sourceHash, configHash, reasoning: 'low', maxOutputTokens: MAX_OUTPUT_TOKENS,
          acknowledgement: sample.acknowledged, responseStatus: sample.responseStatus, usage: sample.usage,
          transcript: sample.transcript, scriptMatched, audioBytes: sample.pcm.length,
          audioSeconds: wav ? validateWav(wav) : 0, elapsedMs: sample.elapsedMs,
          error: sample.error ?? (!wav ? { code: 'NO_AUDIO' } : !scriptMatched ? { code: 'SCRIPT_MISMATCH' } : undefined),
          recordedAt: new Date().toISOString(), transport: 'server-websocket', sampleRate: SAMPLE_RATE, channels: CHANNELS, bitsPerSample: 16,
        };
        // Keep incomplete evidence for review; a later invocation never silently overwrites it or retries it.
        if (wav) await writeFile(`${base}.wav`, wav, { flag: 'wx' });
        await writeFile(`${base}.json`, JSON.stringify(metadata, null, 2), { flag: 'wx' });
        if (!complete) throw new Error(`SAMPLE_FAILED_${name}_${metadata.error?.code ?? 'RESPONSE_FAILED'}`);
        console.log(`Saved ${name}: ${metadata.audioSeconds.toFixed(1)}s PCM, completed, script verified.`);
      }
      clips.push({ voice, model, mp3: `${name}.mp3` });
    }
    await writeFile(join(DIRECTORY, 'manifest.json'), JSON.stringify({ script: SCRIPT, speed: 1, clips }, null, 2));
    console.log('All six WAV samples verified; manifest.json is ready for root to encode the matching MP3 files.');
  } finally {
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    await lock.close(); await unlink(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(`Voice comparison stopped: ${safeCode(error.message) ?? 'CHECK_SAVED_METADATA'}. No automatic retry.`); process.exitCode = 1; });
}
