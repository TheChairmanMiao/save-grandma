/**
 * Grandma's ElevenLabs speech, with browser synthesis when the proxy is unavailable.
 * Playback is sequential, cancellable, and owns every temporary audio URL it creates.
 */
export const ELEVENLABS_ENABLED = import.meta.env.VITE_ELEVENLABS_VOICE === 'true';

const MAX_CACHE_ENTRIES = 16;
const MAX_CACHE_BYTES = 8 * 1024 * 1024;
const MAX_QUEUE_LENGTH = 32;
const AUDIO_TIMEOUT_MS = 12_000;
type Listener = (speaking: boolean) => void;
const listeners = new Set<Listener>();
export function onSpeaking(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
let speaking = false;
const setSpeaking = (value: boolean) => { if (speaking === value) return; speaking = value; listeners.forEach(l => l(value)); };

type Clip = { url: string; bytes: number; released?: boolean };
const cache = new Map<string, Clip>();
let cacheBytes = 0;
function releaseClip(clip: Clip) {
  if (clip.released) return;
  clip.released = true;
  URL.revokeObjectURL(clip.url);
}
function clearCache() {
  cache.forEach(releaseClip);
  cache.clear(); cacheBytes = 0;
}
function cacheClip(text: string, clip: Clip) {
  if (clip.bytes > MAX_CACHE_BYTES) return;
  cache.set(text, clip); cacheBytes += clip.bytes;
  while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    cache.delete(oldest[0]); cacheBytes -= oldest[1].bytes;
    releaseClip(oldest[1]);
  }
}

let generation = 0;
let request: AbortController | null = null;
async function fetchClip(text: string, myGeneration: number): Promise<Clip> {
  const cached = cache.get(text);
  if (cached) { cache.delete(text); cache.set(text, cached); return cached; }
  const abort = new AbortController();
  request = abort;
  const timeout = setTimeout(() => abort.abort(), AUDIO_TIMEOUT_MS);
  try {
    const response = await fetch('/api/speak', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }), signal: abort.signal,
    });
    if (!response.ok) throw new Error('Speech is unavailable.');
    const blob = await response.blob();
    if (abort.signal.aborted || myGeneration !== generation) throw new DOMException('Speech cancelled', 'AbortError');
    const clip = { url: URL.createObjectURL(blob), bytes: blob.size };
    cacheClip(text, clip);
    return clip;
  } finally {
    clearTimeout(timeout);
    if (request === abort) request = null;
  }
}

type Playback = { finish: () => void; cancel: () => void };
let playback: Playback | null = null;
type Job = { text: string; generation: number; resolve: () => void };
const queue: Job[] = [];
let activeJob: Job | null = null;
let drainingGeneration: number | null = null;

function playClip(clip: Clip): Promise<void> {
  return new Promise(resolve => {
    const audio = new Audio(clip.url);
    let finished = false;
    const current: Playback = {
      finish: () => {
        if (finished) return;
        finished = true;
        audio.onended = audio.onerror = null;
        if (playback === current) { playback = null; setSpeaking(false); }
        resolve();
      },
      cancel: () => { audio.pause(); audio.src = ''; current.finish(); },
    };
    playback = current;
    audio.onended = audio.onerror = current.finish;
    setSpeaking(true);
    void audio.play().catch(current.finish);
  });
}

function speakWithBrowser(text: string): Promise<void> {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve();
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.92; utterance.pitch = 1.25; utterance.volume = 1;
    const voices = speechSynthesis.getVoices();
    const preferred = voices.find(v => /en/i.test(v.lang) && /female|samantha|karen|moira|victoria|zira/i.test(v.name)) ?? voices.find(v => /^en/i.test(v.lang));
    if (preferred) utterance.voice = preferred;
    let finished = false;
    const current: Playback = {
      finish: () => {
        if (finished) return;
        finished = true;
        utterance.onend = utterance.onerror = null;
        if (playback === current) { playback = null; setSpeaking(false); }
        resolve();
      },
      cancel: () => { speechSynthesis.cancel(); current.finish(); },
    };
    playback = current;
    utterance.onend = utterance.onerror = current.finish;
    setSpeaking(true);
    try { speechSynthesis.speak(utterance); } catch { current.finish(); }
  });
}

async function drain(myGeneration: number) {
  if (drainingGeneration === myGeneration) return;
  drainingGeneration = myGeneration;
  try {
    while (myGeneration === generation && queue.length) {
      const job = queue.shift()!;
      if (job.generation !== myGeneration) { job.resolve(); continue; }
      activeJob = job;
      let clip: Clip | undefined;
      try {
        if (ELEVENLABS_ENABLED) {
          clip = await fetchClip(job.text, myGeneration);
          if (myGeneration === generation) await playClip(clip);
        } else if (myGeneration === generation) await speakWithBrowser(job.text);
      } catch {
        if (myGeneration === generation) await speakWithBrowser(job.text);
      } finally {
        // Oversized clips are played once and never retained by the cache.
        if (clip && cache.get(job.text) !== clip) releaseClip(clip);
        if (activeJob === job) activeJob = null;
        job.resolve();
      }
    }
  } finally {
    if (drainingGeneration === myGeneration) { drainingGeneration = null; setSpeaking(false); }
  }
}

export function speak(text: string): Promise<void> {
  const trimmed = text.trim();
  if (!trimmed) return Promise.resolve();
  return new Promise(resolve => {
    if (queue.length >= MAX_QUEUE_LENGTH) queue.shift()?.resolve();
    queue.push({ text: trimmed, generation, resolve });
    void drain(generation);
  });
}

/** Always settles callers, even browsers that emit no end event after cancellation. */
export function stopSpeaking() {
  generation++;
  drainingGeneration = null;
  request?.abort(); request = null;
  queue.splice(0).forEach(job => job.resolve());
  activeJob?.resolve(); activeJob = null;
  playback?.cancel(); playback = null;
  clearCache();
  setSpeaking(false);
}
