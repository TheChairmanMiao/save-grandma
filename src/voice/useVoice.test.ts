import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    on(name: string, callback: (...args: any[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); }
    emit(name: string, ...args: any[]) { this.handlers.get(name)?.forEach(callback => callback(...args)); }
  }
  class Transport extends Emitter { sendEvent = vi.fn(); }
  class Session extends Emitter {
    transport: Transport;
    close = vi.fn(); mute = vi.fn(); interrupt = vi.fn(); sendMessage = vi.fn();
    connect = vi.fn(() => state.connectionResults.shift() ?? Promise.resolve());
    constructor(_agent: unknown, public options: { transport: Transport; config: { outputModalities: string[]; audio: { output: { voice: string } } } }) { super(); this.transport = options.transport; state.sessions.push(this); }
  }
  const state = {
    values: [] as unknown[], cleanups: [] as (() => void)[], sessions: [] as Session[],
    connectionResults: [] as Promise<void>[], Session, Transport,
    speak: vi.fn(() => Promise.resolve()), stopSpeaking: vi.fn(),
  };
  return state;
});
vi.mock('react', () => ({
  useRef: <T>(value: T) => ({ current: value }),
  useCallback: <T>(fn: T) => fn,
  useEffect: (effect: () => void | (() => void)) => { const cleanup = effect(); if (cleanup) harness.cleanups.push(cleanup); },
  useState: <T>(initial: T | (() => T)) => {
    const slot = harness.values.length;
    const value = typeof initial === 'function' ? (initial as () => T)() : initial;
    harness.values.push(value);
    return [value, (next: T | ((old: T) => T)) => { harness.values[slot] = typeof next === 'function' ? (next as (old: T) => T)(harness.values[slot] as T) : next; }];
  },
}));
vi.mock('@openai/agents/realtime', () => ({ RealtimeSession: harness.Session, OpenAIRealtimeWebRTC: harness.Transport }));
vi.mock('./grandma', () => ({ grandmaAgent: {} }));
vi.mock('./grandma-voice', () => ({ speak: harness.speak, stopSpeaking: harness.stopSpeaking, onSpeaking: () => () => {} }));
import { useVoice } from './useVoice';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function stream() { const stop = vi.fn(); return { value: { getTracks: () => [{ stop }] } as unknown as MediaStream, stop }; }
const flush = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 12; i++) await Promise.resolve(); };
const token = () => Promise.resolve({ ok: true, json: async () => ({ value: 'ek_test' }) });

beforeEach(() => {
  vi.useFakeTimers();
  harness.values.length = harness.cleanups.length = harness.sessions.length = harness.connectionResults.length = 0;
  harness.speak.mockClear(); harness.stopSpeaking.mockClear();
  vi.stubGlobal('fetch', vi.fn(token));
  vi.stubGlobal('document', { createElement: () => ({ autoplay: false, muted: false, play: vi.fn(() => Promise.resolve()), pause: vi.fn(), src: '', srcObject: null }) });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream().value) } });
});
afterEach(() => {
  harness.cleanups.splice(0).forEach(cleanup => cleanup());
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('voice connection lifecycle without network or microphone access', () => {
  it('always requests native OpenAI audio even when legacy provider environment values exist', async () => {
    vi.stubEnv('VITE_ELEVENLABS_VOICE', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'unused-legacy-value');
    vi.stubEnv('ELEVENLABS_VOICE_ID', 'unused-legacy-voice');
    const voice = useVoice();
    await voice.connect();
    const session = harness.sessions[0];
    expect(session.options.config.outputModalities).toEqual(['audio']);
    session.transport.emit('output_text_delta', { responseId: 'reply', delta: 'Native audio handles this. ' });
    session.transport.emit('*', { type: 'response.done' });
    expect(harness.speak).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(['/api/realtime-token']);
  });

  it('checks backend availability before asking for the microphone', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    const voice = useVoice();
    await voice.connect();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(harness.sessions).toHaveLength(0);
    expect(harness.values[0]).toBe('error');
  });

  it('deduplicates concurrent connection attempts', async () => {
    const waiting = deferred<Response>();
    vi.mocked(fetch).mockReturnValue(waiting.promise);
    const voice = useVoice();
    const first = voice.connect();
    expect(voice.connect()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    waiting.resolve(await token() as Response);
    await first;
    expect(harness.sessions).toHaveLength(1);
    expect(harness.values[0]).toBe('connected');
  });

  it('aborts a stalled token request and leaves typed play available', async () => {
    vi.mocked(fetch).mockReturnValue(new Promise(() => {}));
    const voice = useVoice();
    const pending = voice.connect();
    const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
    expect(signal?.aborted).toBe(true);
    expect(harness.values[0]).toBe('error');
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it('stops a late permission stream without touching a newer call', async () => {
    const late = deferred<MediaStream>();
    const oldStream = stream(); const newStream = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValueOnce(late.promise).mockResolvedValueOnce(newStream.value);
    const voice = useVoice();
    const oldConnect = voice.connect();
    await flush();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    voice.disconnect();
    await oldConnect;
    await voice.connect();
    late.resolve(oldStream.value);
    await flush();
    expect(oldStream.stop).toHaveBeenCalledOnce();
    expect(newStream.stop).not.toHaveBeenCalled();
    expect(harness.values[0]).toBe('connected');
  });

  it('tears down provider errors and ignores old-session callbacks after retry', async () => {
    const oldStream = stream(); const newStream = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(oldStream.value).mockResolvedValueOnce(newStream.value);
    const voice = useVoice();
    await voice.connect();
    const oldSession = harness.sessions[0];
    oldSession.emit('error', { type: 'error', error: new Error('provider failure') });
    expect(oldStream.stop).toHaveBeenCalledOnce();
    expect(oldSession.close).toHaveBeenCalledOnce();
    expect(harness.values[0]).toBe('error');
    await voice.connect();
    const currentValues = [...harness.values];
    oldSession.emit('audio_start');
    oldSession.emit('history_updated', [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'stale' }] }]);
    oldSession.emit('error', { type: 'error', error: 'late error' });
    oldSession.transport.emit('connection_change', 'disconnected');
    expect(harness.values).toEqual(currentValues);
    expect(newStream.stop).not.toHaveBeenCalled();
  });

  it('cleans up a runtime transport disconnection', async () => {
    const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(mic.value);
    const voice = useVoice();
    await voice.connect();
    harness.sessions[0].transport.emit('connection_change', 'disconnected');
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.values[0]).toBe('error');
  });

  it('times out connection setup and ignores a late connection result', async () => {
    const waiting = deferred<void>();
    harness.connectionResults.push(waiting.promise);
    const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(mic.value);
    const voice = useVoice();
    const pending = voice.connect();
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.values[0]).toBe('error');
    waiting.resolve(); await flush();
    expect(harness.values[0]).toBe('error');
  });

  it('ends normal calls after six minutes and preserves their last captions', async () => {
    const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(mic.value);
    const voice = useVoice();
    await voice.connect();
    harness.sessions[0].emit('history_updated', [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello dear' }] }]);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.values[0]).toBe('idle');
    expect(harness.values[2]).toBe('Hello dear');
  });

  it('hushes native audio and cancels any scripted browser speech', async () => {
    const voice = useVoice();
    await voice.connect();
    const s = harness.sessions[0];
    s.emit('audio_start');
    expect(harness.values[4]).toBe(true);
    voice.hush();
    expect(harness.stopSpeaking).toHaveBeenCalled();
    expect(s.interrupt).toHaveBeenCalledOnce();
    expect(harness.values[4]).toBe(false);
  });

  it('mutes a live call without stopping standalone fallback speech when no voice session exists', async () => {
    const voice = useVoice();
    voice.setOutputMuted(true);
    expect(harness.stopSpeaking).not.toHaveBeenCalled();
    voice.setOutputMuted(false);
    await voice.connect();
    const s = harness.sessions[0];
    s.emit('audio_start');
    voice.setOutputMuted(true);
    expect(harness.stopSpeaking).toHaveBeenCalledOnce();
    expect(harness.values[4]).toBe(false);
    voice.setOutputMuted(false);
    s.emit('audio_start');
    expect(harness.values[4]).toBe(true);
  });

  it('releases a permission stream that arrives after unmount', async () => {
    const late = deferred<MediaStream>(); const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(late.promise);
    const voice = useVoice();
    const pending = voice.connect();
    await flush();
    harness.cleanups.splice(0).forEach(cleanup => cleanup());
    await pending;
    late.resolve(mic.value); await flush();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.sessions).toHaveLength(0);
  });
});
