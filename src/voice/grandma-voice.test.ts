import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Voice = typeof import('./grandma-voice');
let voice: Voice | undefined;
let serial = 0;
class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play = vi.fn(() => Promise.resolve());
  pause = vi.fn();
  constructor(public src: string) { audio.push(this); }
}
class Utterance {
  rate = 1; pitch = 1; volume = 1; voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
const audio: FakeAudio[] = [];
const spoken: Utterance[] = [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const audioResponse = (bytes = 100) => ({ ok: true, blob: async () => ({ size: bytes } as Blob) }) as Response;
async function load(enabled = true) {
  vi.stubEnv('VITE_ELEVENLABS_VOICE', String(enabled));
  voice = await import('./grandma-voice');
  return voice;
}
async function completeAudio() { await flush(); audio.at(-1)?.onended?.(); await flush(); }

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers();
  serial = 0; audio.length = spoken.length = 0;
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  vi.stubGlobal('speechSynthesis', { getVoices: () => [], speak: vi.fn((utterance: Utterance) => spoken.push(utterance)), cancel: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(async () => audioResponse()));
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:test-${++serial}`);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  voice?.stopSpeaking(); voice = undefined;
  vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('Grandma speech lifecycle', () => {
  it('settles active and queued browser speech when cancellation emits no end event', async () => {
    const speech = await load(false);
    const first = speech.speak('First line.');
    const queued = speech.speak('Second line.');
    await flush();
    expect(spoken.map(item => item.text)).toEqual(['First line.']);
    speech.stopSpeaking();
    await Promise.all([first, queued]);
    expect(speechSynthesis.cancel).toHaveBeenCalledOnce();
    const next = speech.speak('A fresh line.');
    await flush();
    expect(spoken.at(-1)?.text).toBe('A fresh line.');
    spoken.at(-1)?.onend?.();
    await next;
    expect(fetch).not.toHaveBeenCalled();
  });

  it('settles cancelled audio and queued lines, and revokes the active clip exactly once', async () => {
    const speech = await load();
    const first = speech.speak('First line.'); const second = speech.speak('Second line.');
    await flush();
    expect(audio).toHaveLength(1);
    speech.stopSpeaking();
    await Promise.all([first, second]); await flush();
    expect(audio[0].pause).toHaveBeenCalledOnce();
    expect(audio[0].src).toBe('');
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-1');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('ignores an old audio request after cancellation while a newer line plays', async () => {
    let finishOld!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finishOld = resolve; }));
    const speech = await load();
    const old = speech.speak('Old line.');
    await flush();
    const oldSignal = vi.mocked(fetch).mock.calls[0][1]?.signal;
    speech.stopSpeaking(); await old;
    expect(oldSignal?.aborted).toBe(true);
    const current = speech.speak('New line.');
    await flush();
    finishOld(audioResponse()); await flush();
    expect(audio).toHaveLength(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    audio[0].onended?.(); await current;
  });

  it('falls back to cancellable browser speech when the proxy fails', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
    const speech = await load();
    const pending = speech.speak('Still here, dear.');
    await flush();
    expect(spoken[0].text).toBe('Still here, dear.');
    speech.stopSpeaking(); await pending;
    expect(audio).toHaveLength(0);
  });

  it('reuses cached speech and releases URLs when the call ends', async () => {
    const speech = await load();
    let pending = speech.speak('Hello dear.');
    await completeAudio(); await pending;
    pending = speech.speak('Hello dear.');
    await completeAudio(); await pending;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(audio).toHaveLength(2);
    speech.stopSpeaking();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-1');
  });

  it('evicts older cached clips after sixteen distinct lines', async () => {
    const speech = await load();
    for (let i = 0; i < 17; i++) {
      const pending = speech.speak(`Line ${i}.`);
      await completeAudio(); await pending;
    }
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-1');
    speech.stopSpeaking();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(17);
  });

  it('bounds the audio cache by total blob bytes as well as line count', async () => {
    vi.mocked(fetch).mockImplementation(async () => audioResponse(5 * 1024 * 1024));
    const speech = await load();
    let pending = speech.speak('One long line.');
    await completeAudio(); await pending;
    pending = speech.speak('Another long line.');
    await completeAudio(); await pending;
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:test-1');
    speech.stopSpeaking();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('aborts a stalled speech request and uses browser speech after the timeout', async () => {
    vi.mocked(fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const speech = await load();
    const pending = speech.speak('Can you hear me?');
    await vi.advanceTimersByTimeAsync(12_000);
    expect(vi.mocked(fetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(spoken[0]?.text).toBe('Can you hear me?');
    speech.stopSpeaking(); await pending;
  });
});
