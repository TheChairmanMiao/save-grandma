import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Voice = typeof import('./grandma-voice');
let voice: Voice | undefined;
class Utterance {
  rate = 1; pitch = 1; volume = 1; voice: SpeechSynthesisVoice | null = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}
const spoken: Utterance[] = [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function load() { voice = await import('./grandma-voice'); return voice; }

beforeEach(() => {
  vi.resetModules(); spoken.length = 0;
  vi.stubGlobal('SpeechSynthesisUtterance', Utterance);
  vi.stubGlobal('speechSynthesis', { getVoices: () => [], speak: vi.fn((utterance: Utterance) => spoken.push(utterance)), cancel: vi.fn() });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Local browser speech must not request an API.'); }));
});
afterEach(() => {
  voice?.stopSpeaking(); voice = undefined;
  vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('local scripted browser speech', () => {
  it('uses browser synthesis without external TTS even with legacy provider settings', async () => {
    vi.stubEnv('VITE_ELEVENLABS_VOICE', 'true');
    vi.stubEnv('ELEVENLABS_API_KEY', 'unused-legacy-value');
    const speech = await load();
    const pending = speech.speak('  Give me a second, kid.  ');
    expect(spoken[0].text).toBe('Give me a second, kid.');
    expect(spoken[0].rate).toBe(1.05);
    expect(spoken[0].pitch).toBe(0.95);
    spoken[0].onend?.(); await pending;
    expect(fetch).not.toHaveBeenCalled();
  });

  it('plays scripted lines in order', async () => {
    const speech = await load();
    const first = speech.speak('First line.'); const second = speech.speak('Second line.');
    expect(spoken.map(item => item.text)).toEqual(['First line.']);
    spoken[0].onend?.(); await first; await flush();
    expect(spoken.map(item => item.text)).toEqual(['First line.', 'Second line.']);
    spoken[1].onend?.(); await second;
  });

  it('settles cancelled active and queued speech even when the browser emits no end event', async () => {
    const speech = await load();
    const first = speech.speak('First line.'); const second = speech.speak('Second line.');
    speech.stopSpeaking(); await Promise.all([first, second]);
    expect(speechSynthesis.cancel).toHaveBeenCalledOnce();
    expect(spoken).toHaveLength(1);
    const next = speech.speak('A fresh line.'); await flush();
    expect(spoken.at(-1)?.text).toBe('A fresh line.');
    spoken.at(-1)?.onend?.(); await next;
  });

  it('ignores late completion callbacks from cancelled speech', async () => {
    const speech = await load();
    const updates: boolean[] = [];
    speech.onSpeaking(value => updates.push(value));
    const old = speech.speak('Old line.');
    const finishOld = spoken[0].onend;
    speech.stopSpeaking(); await old;
    const next = speech.speak('Current line.');
    finishOld?.(); await flush();
    expect(updates.at(-1)).toBe(true);
    spoken.at(-1)?.onend?.(); await next;
    expect(updates.at(-1)).toBe(false);
  });

  it('keeps typed play available when browser synthesis is missing', async () => {
    vi.stubGlobal('speechSynthesis', undefined);
    vi.stubGlobal('SpeechSynthesisUtterance', undefined);
    const speech = await load();
    await speech.speak('The transcript still works.');
    expect(fetch).not.toHaveBeenCalled();
    expect(spoken).toHaveLength(0);
  });

  it('continues the queue after a browser playback error', async () => {
    const speech = await load();
    const first = speech.speak('First line.'); const next = speech.speak('Second line.');
    spoken[0].onerror?.(); await first; await flush();
    expect(spoken.at(-1)?.text).toBe('Second line.');
    spoken.at(-1)?.onend?.(); await next;
    expect(fetch).not.toHaveBeenCalled();
  });
});
