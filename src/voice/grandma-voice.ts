/**
 * Local browser speech for scripted lines when the live OpenAI call is unavailable.
 * This fallback queues and cancels playback without making API requests.
 */
const MAX_QUEUE_LENGTH = 32;
type Listener = (speaking: boolean) => void;
const listeners = new Set<Listener>();
export function onSpeaking(listener: Listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }
let speaking = false;
const setSpeaking = (value: boolean) => { if (speaking === value) return; speaking = value; listeners.forEach(l => l(value)); };

type Playback = { finish: () => void; cancel: () => void };
let playback: Playback | null = null;
type Job = { text: string; generation: number; resolve: () => void };
const queue: Job[] = [];
let activeJob: Job | null = null;
let generation = 0;
let drainingGeneration: number | null = null;

function speakWithBrowser(text: string): Promise<void> {
  if (typeof speechSynthesis === 'undefined' || typeof SpeechSynthesisUtterance === 'undefined') return Promise.resolve();
  return new Promise(resolve => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05; utterance.pitch = 0.95; utterance.volume = 1;
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
      try { await speakWithBrowser(job.text); }
      finally {
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
  queue.splice(0).forEach(job => job.resolve());
  activeJob?.resolve(); activeJob = null;
  playback?.cancel(); playback = null;
  setSpeaking(false);
}
