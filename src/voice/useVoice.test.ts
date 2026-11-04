import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  class Emitter {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    on(name: string, callback: (...args: any[]) => void) { this.handlers.set(name, [...(this.handlers.get(name) ?? []), callback]); }
    emit(name: string, ...args: any[]) { this.handlers.get(name)?.forEach(callback => callback(...args)); }
  }
  class Transport extends Emitter {
    sendEvent = vi.fn();
    updateSessionConfig = vi.fn();
    requestResponse = vi.fn(() => this.sendEvent({ type: 'response.create' }));
    sender: { track: MediaStreamTrack | null; replaceTrack: ReturnType<typeof vi.fn> };
    connectionState: { peerConnection: { getSenders: () => { track: MediaStreamTrack | null; replaceTrack: ReturnType<typeof vi.fn> }[] } };
    constructor(public options: { mediaStream: MediaStream; audioElement: HTMLAudioElement }) {
      super();
      this.sender = { track: options.mediaStream.getAudioTracks()[0], replaceTrack: vi.fn(async (track: MediaStreamTrack | null) => { this.sender.track = track; }) };
      this.connectionState = { peerConnection: { getSenders: () => [this.sender] } };
    }
  }
  class Session extends Emitter {
    transport: Transport;
    close = vi.fn();
    mute = vi.fn((value: boolean) => { if (this.transport.sender.track) this.transport.sender.track.enabled = !value; });
    interrupt = vi.fn();
    sendMessage = vi.fn((text: string) => { this.transport.sendEvent({ type: 'conversation.item.create', text }); this.transport.requestResponse(); });
    connect = vi.fn(() => state.connectionResults.shift() ?? Promise.resolve());
    constructor(_agent: unknown, public options: { transport: Transport; config: { outputModalities: string[]; reasoning: { effort: string }; audio: { input: { turnDetection: { createResponse: boolean; interruptResponse: boolean } }; output: { voice: string } } } }) { super(); this.transport = options.transport; state.sessions.push(this); }
  }
  class Context {
    state = 'suspended';
    track = { kind: 'audio', enabled: true, stop: vi.fn() };
    stream = { getTracks: () => [this.track], getAudioTracks: () => [this.track] };
    resume = vi.fn((): Promise<void> => { this.state = 'running'; return state.resumeResults.shift() ?? Promise.resolve(); });
    close = vi.fn(async () => { this.state = 'closed'; });
    createMediaStreamDestination = () => ({ stream: this.stream });
    constructor() { state.contexts.push(this); }
  }
  const state = {
    values: [] as unknown[], cleanups: [] as (() => void)[], sessions: [] as Session[],
    connectionResults: [] as Promise<void>[], resumeResults: [] as Promise<void>[], contexts: [] as Context[], Session, Transport, Context,
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
function stream() {
  const stop = vi.fn(); const track = { kind: 'audio', enabled: true, stop };
  return { value: { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream, stop, track };
}
const flush = async () => { await vi.dynamicImportSettled(); for (let i = 0; i < 12; i++) await Promise.resolve(); };
const token = () => Promise.resolve({ ok: true, json: async () => ({ value: 'ek_test' }) });

beforeEach(() => {
  vi.useFakeTimers();
  harness.values.length = harness.cleanups.length = harness.sessions.length = harness.connectionResults.length = 0;
  harness.contexts.length = harness.resumeResults.length = 0;
  harness.speak.mockClear(); harness.stopSpeaking.mockClear();
  vi.stubGlobal('fetch', vi.fn(token));
  vi.stubGlobal('document', { createElement: () => ({ autoplay: false, muted: false, play: vi.fn(() => Promise.resolve()), pause: vi.fn(), src: '', srcObject: null }) });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(async () => stream().value) } });
  vi.stubGlobal('AudioContext', harness.Context);
  vi.stubGlobal('window', Object.assign(new EventTarget(), { location: { origin: 'https://demo.example' } }));
});
afterEach(() => {
  harness.cleanups.splice(0).forEach(cleanup => cleanup());
  vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('voice connection lifecycle without network or microphone access', () => {
  it('keeps public call authorization on the same-origin relay and closes the server call when leaving', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ value: 'ek_demo_single_use', relay: true }) } as Response);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    expect(harness.sessions[0].connect).toHaveBeenCalledWith({ apiKey: 'ek_demo_single_use', url: 'https://demo.example/api/realtime-call' });
    window.dispatchEvent(new Event('pagehide'));
    expect(harness.sessions[0].close).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenLastCalledWith('/api/realtime-close', { method: 'POST', headers: { Authorization: 'Bearer ek_demo_single_use' }, keepalive: true });
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });

  it.each([
    ['DAILY_LIMIT', 'Today’s 10 AI calls are used up'],
    ['BUSY', 'Grandma is on another AI call'],
  ])('explains %s without opening media or another call', async (code, message) => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({ code }) } as Response);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    expect(harness.values[0]).toBe('error');
    expect(harness.values[1]).toContain(message);
    expect(harness.sessions).toHaveLength(0);
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
  });
  it('connects typed chat with native spoken replies without requesting microphone permission', async () => {
    const voice = useVoice();
    const pending = voice.connect({ microphone: false });
    expect(harness.contexts).toHaveLength(1);
    expect(harness.contexts[0].resume).toHaveBeenCalledOnce();
    await pending;
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    const s = harness.sessions[0];
    expect(s.options.config.outputModalities).toEqual(['audio']);
    expect(s.options.config.reasoning).toEqual({ effort: 'low' });
    expect(s.options.config.audio.input.turnDetection).toMatchObject({ createResponse: false, interruptResponse: false });
    expect(s.transport.sender.track).toBe(harness.contexts[0].track);
    expect(s.transport.sender.track?.enabled).toBe(false);
    expect(harness.values[0]).toBe('connected');
    expect(harness.values[9]).toBe(false);
    s.emit('transport_event', { type: 'input_audio_buffer.speech_started' });
    s.emit('transport_event', { type: 'input_audio_buffer.committed' });
    expect(harness.values[8]).toBe(false);
    expect(harness.values[5]).toBe(0);
    expect(harness.values[6]).toBe(0);
    expect(s.transport.sendEvent).not.toHaveBeenCalled();
  });

  it('sends each typed message once and lets the SDK request exactly one response', async () => {
    const voice = useVoice();
    expect(voice.sendText('Not connected yet.')).toBe(false);
    await voice.connect({ microphone: false });
    const s = harness.sessions[0];
    expect(voice.sendText('  turn off selfie mode  ')).toBe(true);
    expect(s.interrupt).not.toHaveBeenCalled();
    expect(s.sendMessage).toHaveBeenCalledExactlyOnceWith('turn off selfie mode');
    expect(s.transport.sendEvent.mock.calls.filter(([event]) => event.type === 'response.create')).toHaveLength(1);
    expect(harness.values[8]).toBe(true);
    expect(s.transport.options.audioElement.muted).toBe(false);
    expect(voice.sendText('  ')).toBe(false);
    expect(s.sendMessage).toHaveBeenCalledOnce();
    // An old response's cancellation may complete while the new reply is queued.
    s.emit('transport_event', { type: 'response.done' });
    expect(harness.values[8]).toBe(true);
    s.emit('transport_event', { type: 'response.created' });
    expect(harness.values[8]).toBe(true);
    s.emit('transport_event', { type: 'response.done' });
    expect(harness.values[8]).toBe(false);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(s.transport.options.audioElement.muted).toBe(false);
  });

  it('exposes stable SDK item IDs for transcript reconciliation', async () => {
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const s = harness.sessions[0];
    const user = { itemId: 'user-1', type: 'message', role: 'user', status: 'completed', content: [{ type: 'input_text', text: 'Turn the camera around.' }] };
    s.emit('history_updated', [user, { itemId: 'assistant-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_audio', transcript: 'All right, kid.' }] }]);
    expect(harness.values[10]).toEqual({ id: 'assistant-1', text: 'All right, kid.' });
    expect(harness.values[11]).toEqual({ id: 'user-1', text: 'Turn the camera around.' });
    const stableAssistant = harness.values[10];
    s.emit('history_updated', [user, { itemId: 'assistant-1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_audio', transcript: 'All right, kid.' }] }]);
    expect(harness.values[10]).toBe(stableAssistant);
    s.emit('history_updated', [user, { ...user, itemId: 'user-2' }]);
    expect(harness.values[11]).toEqual({ id: 'user-2', text: 'Turn the camera around.' });
  });

  it('automatically tracks speech response lifecycle without manual respond calls', async () => {
    const voice = useVoice();
    await voice.connect();
    const s = harness.sessions[0];
    s.emit('transport_event', { type: 'input_audio_buffer.committed' });
    expect(harness.values[8]).toBe(true);
    s.emit('transport_event', { type: 'response.created' });
    s.emit('transport_event', { type: 'response.done' });
    expect(harness.values[8]).toBe(false);
    expect(s.transport.sendEvent).not.toHaveBeenCalled();
  });

  it('keeps a new typed response connected through a recoverable cancellation error', async () => {
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const s = harness.sessions[0];
    s.emit('transport_event', { type: 'response.created', response: { id: 'old' } });
    s.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'old' });
    expect(voice.sendText('Turn off selfie mode.')).toBe(true);
    expect(s.interrupt).toHaveBeenCalledOnce();
    s.emit('error', { type: 'error', error: { type: 'error', error: { type: 'invalid_request_error', code: 'response_cancel_not_active', message: 'private provider detail' } } });
    expect(harness.values[0]).toBe('connected');
    expect(harness.values[1]).toBe('');
    expect(harness.values[8]).toBe(true);
    expect(s.close).not.toHaveBeenCalled();
    s.emit('transport_event', { type: 'response.created', response: { id: 'new' } });
    s.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'new' });
    // Old response completion and audio-generation callbacks cannot hide this playback.
    s.emit('transport_event', { type: 'response.done', response: { id: 'old', status: 'cancelled' } });
    s.emit('transport_event', { type: 'output_audio_buffer.cleared', response_id: 'old' });
    s.emit('audio_stopped'); s.emit('audio_interrupted');
    expect(harness.values[8]).toBe(true);
    expect(harness.values[4]).toBe(true);
    s.emit('transport_event', { type: 'response.done', response: { id: 'new', status: 'completed' } });
    expect(harness.values[8]).toBe(false);
    expect(harness.values[4]).toBe(true);
    s.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: 'new' });
    expect(harness.values[4]).toBe(false);
    expect(s.sendMessage).toHaveBeenCalledOnce();
  });

  it('clears an already-requested reply before queuing the next typed message without a timer', async () => {
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const s = harness.sessions[0];
    voice.greet();
    // The greeting request is in flight; response.created has not arrived yet.
    expect(voice.sendText('Skip that, turn around.')).toBe(true);
    expect(s.interrupt).toHaveBeenCalledOnce();
    expect(s.interrupt.mock.invocationCallOrder[0]).toBeLessThan(s.sendMessage.mock.invocationCallOrder[0]);
    expect(s.sendMessage).toHaveBeenCalledExactlyOnceWith('Skip that, turn around.');
    expect(harness.values[8]).toBe(true);
  });

  it.each(['preamble', 'tool-result'])('drains continuous tool-result audio when its final stop names %s', async finalId => {
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const s = harness.sessions[0];
    voice.sendText('Tell me what you see.');
    s.emit('transport_event', { type: 'response.created', response: { id: 'preamble' } });
    s.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'preamble' });
    s.emit('transport_event', { type: 'response.output_audio.done', response_id: 'preamble' });
    s.emit('transport_event', { type: 'response.done', response: { id: 'preamble', status: 'completed' } });
    s.emit('transport_event', { type: 'response.created', response: { id: 'tool-result' } });
    // A continuation can extend the same server buffer without another started event.
    s.emit('transport_event', { type: 'response.output_audio.done', response_id: 'tool-result' });
    s.emit('transport_event', { type: 'response.done', response: { id: 'tool-result', status: 'completed' } });
    expect(harness.values[8]).toBe(false);
    expect(harness.values[4]).toBe(true);
    s.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: finalId });
    expect(harness.values[4]).toBe(false);
  });

  it('keeps an interrupted continuous buffer from clearing newer playback', async () => {
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const s = harness.sessions[0];
    s.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'preamble' });
    s.emit('transport_event', { type: 'response.output_audio.done', response_id: 'tool-result' });
    voice.sendText('Stop looking and turn around.');
    s.emit('transport_event', { type: 'response.created', response: { id: 'new' } });
    s.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'new' });
    s.emit('transport_event', { type: 'response.output_audio.done', response_id: 'tool-result' });
    s.emit('transport_event', { type: 'output_audio_buffer.cleared', response_id: 'tool-result' });
    s.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: 'preamble' });
    expect(harness.values[4]).toBe(true);
    s.emit('transport_event', { type: 'output_audio_buffer.stopped', response_id: 'new' });
    expect(harness.values[4]).toBe(false);
  });

  it('keeps recoverable response and SDK tool errors local to the current message', async () => {
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const s = harness.sessions[0];
    voice.sendText('Look around.');
    s.emit('error', { type: 'error', error: { type: 'error', error: { type: 'invalid_request_error', code: 'invalid_event', message: 'private provider detail' } } });
    expect(harness.values[0]).toBe('connected');
    expect(harness.values[8]).toBe(false);
    expect(harness.values[1]).toBe('Grandma missed that message. Please try again.');
    expect(s.close).not.toHaveBeenCalled();
    voice.sendText('Try looking again.');
    expect(harness.values[1]).toBe('');
    s.emit('transport_event', { type: 'response.created', response: { id: 'retry' } });
    s.emit('transport_event', { type: 'response.done', response: { id: 'retry', status: 'failed' } });
    expect(harness.values[8]).toBe(false);
    expect(harness.values[0]).toBe('connected');
    s.emit('error', { type: 'error', error: new Error('a tool failed') });
    expect(s.close).not.toHaveBeenCalled();
  });

  it('enables and disables the microphone by swapping tracks in the same conversation', async () => {
    const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(mic.value);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const s = harness.sessions[0]; const context = harness.contexts[0];
    expect(await voice.setMicrophoneEnabled(true)).toBe(true);
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(s.transport.sender.track).toBe(mic.track);
    expect(mic.track.enabled).toBe(true);
    expect(harness.values[9]).toBe(true);
    expect(s.transport.updateSessionConfig).toHaveBeenLastCalledWith(expect.objectContaining({
      outputModalities: ['audio'],
      reasoning: { effort: 'low' },
      audio: expect.objectContaining({
        input: expect.objectContaining({
          transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
          turnDetection: expect.objectContaining({ createResponse: true, interruptResponse: true }),
        }),
        output: expect.objectContaining({ voice: 'coral' }),
      }),
    }));
    expect(await voice.setMicrophoneEnabled(false)).toBe(false);
    expect(s.transport.sender.track).toBe(context.track);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.values[9]).toBe(false);
    expect(s.transport.updateSessionConfig).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.objectContaining({ input: expect.objectContaining({ turnDetection: expect.objectContaining({ createResponse: false, interruptResponse: false }) }) }) }));
    expect(s.transport.updateSessionConfig.mock.calls.every(([config]) => config.reasoning?.effort === 'low')).toBe(true);
    expect(harness.sessions).toHaveLength(1);
    expect(s.close).not.toHaveBeenCalled();
    expect(voice.sendText('Keep talking.')).toBe(true);
    voice.disconnect();
    expect(context.track.stop).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
  });

  it('disables automatic speech responses during app mute and restores them only for an active mic', async () => {
    const voice = useVoice();
    await voice.connect();
    const s = harness.sessions[0];
    expect(s.options.config.audio.input.turnDetection).toMatchObject({ createResponse: true, interruptResponse: true });
    voice.setMute(true);
    expect(s.transport.updateSessionConfig).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.objectContaining({ input: expect.objectContaining({ turnDetection: expect.objectContaining({ createResponse: false, interruptResponse: false }) }) }) }));
    s.emit('transport_event', { type: 'input_audio_buffer.committed' });
    expect(harness.values[8]).toBe(false);
    voice.setMute(false);
    expect(s.transport.updateSessionConfig).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.objectContaining({ input: expect.objectContaining({ turnDetection: expect.objectContaining({ createResponse: true, interruptResponse: true }) }) }) }));
  });

  it('starts app-muted mic sessions with automatic responses disabled and applies mute changes after readiness', async () => {
    const waiting = deferred<void>();
    harness.connectionResults.push(waiting.promise);
    const voice = useVoice();
    voice.setMute(true);
    const pending = voice.connect();
    await flush();
    const s = harness.sessions[0];
    expect(s.options.config.audio.input.turnDetection).toMatchObject({ createResponse: false, interruptResponse: false });
    voice.setMute(false);
    expect(s.transport.updateSessionConfig).not.toHaveBeenCalled();
    waiting.resolve(); await pending;
    expect(s.transport.updateSessionConfig).toHaveBeenLastCalledWith(expect.objectContaining({ audio: expect.objectContaining({ input: expect.objectContaining({ turnDetection: expect.objectContaining({ createResponse: true, interruptResponse: true }) }) }) }));
  });

  it('keeps AI typed chat connected if microphone permission is denied', async () => {
    vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(new DOMException('Blocked', 'NotAllowedError'));
    const voice = useVoice();
    await voice.connect({ microphone: false });
    expect(await voice.setMicrophoneEnabled(true)).toBe(false);
    expect(harness.values[0]).toBe('connected');
    expect(harness.values[9]).toBe(false);
    expect(harness.values[1]).toMatch(/still chat by typing/);
    expect(voice.sendText('What can you see?')).toBe(true);
    expect(harness.sessions[0].close).not.toHaveBeenCalled();
  });

  it('stops a microphone stream returned after the user turned microphone input off', async () => {
    const permission = deferred<MediaStream>(); const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(permission.promise);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const pending = voice.setMicrophoneEnabled(true);
    expect(voice.setMicrophoneEnabled(true)).toBe(pending);
    await voice.setMicrophoneEnabled(false);
    expect(await pending).toBe(false);
    permission.resolve(mic.value); await flush();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.sessions[0].transport.sender.track).toBe(harness.contexts[0].track);
    expect(harness.values[0]).toBe('connected');
    expect(harness.values[9]).toBe(false);
  });

  it('closes the silent context and disposes a late microphone stream after disconnect', async () => {
    const permission = deferred<MediaStream>(); const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(permission.promise);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    const context = harness.contexts[0];
    const pending = voice.setMicrophoneEnabled(true);
    voice.disconnect();
    expect(await pending).toBe(false);
    permission.resolve(mic.value); await flush();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.track.stop).toHaveBeenCalledOnce();
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.values[0]).toBe('idle');
  });

  it('releases a newly permitted microphone when replacing the audio sender fails', async () => {
    const mic = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValue(mic.value);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    harness.sessions[0].transport.sender.replaceTrack.mockRejectedValueOnce(new Error('Failed to replace'));
    expect(await voice.setMicrophoneEnabled(true)).toBe(false);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(harness.values[0]).toBe('connected');
    expect(harness.values[9]).toBe(false);
  });

  it('cleans up the silent context when the backend is unavailable', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, json: async () => ({}) } as Response);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    expect(harness.contexts[0].close).toHaveBeenCalledOnce();
    expect(harness.contexts[0].track.stop).toHaveBeenCalledOnce();
    expect(navigator.mediaDevices.getUserMedia).not.toHaveBeenCalled();
    expect(harness.values[0]).toBe('error');
    expect(harness.values[8]).toBe(false);
  });

  it('closes an audio context even if its resume finishes after disconnection', async () => {
    const resumed = deferred<void>();
    harness.resumeResults.push(resumed.promise);
    const voice = useVoice();
    await voice.connect({ microphone: false });
    voice.disconnect();
    resumed.resolve(); await flush();
    expect(harness.contexts[0].state).toBe('closed');
    expect(harness.contexts[0].close).toHaveBeenCalledOnce();
  });

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

  it('tears down expired sessions and ignores old-session callbacks after retry', async () => {
    const oldStream = stream(); const newStream = stream();
    vi.mocked(navigator.mediaDevices.getUserMedia).mockResolvedValueOnce(oldStream.value).mockResolvedValueOnce(newStream.value);
    const voice = useVoice();
    await voice.connect();
    const oldSession = harness.sessions[0];
    oldSession.emit('error', { type: 'error', error: { type: 'error', error: { code: 'session_expired' } } });
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
    s.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'speaking' });
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
    s.emit('transport_event', { type: 'output_audio_buffer.started', response_id: 'speaking' });
    voice.setOutputMuted(true);
    expect(harness.stopSpeaking).toHaveBeenCalledOnce();
    expect(harness.values[4]).toBe(false);
    voice.setOutputMuted(false);
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
