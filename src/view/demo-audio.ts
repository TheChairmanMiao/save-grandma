/**
 * Original, procedural demo sounds. These use oscillators and generated noise only;
 * none of the recordings in public/audio are loaded by the playable demo.
 */
export type DemoSound = 'title' | 'water' | 'alarm' | 'ringtone';
export type DemoAudio = { stop: () => void };

let context: AudioContext | undefined;

function audioContext() {
  if (typeof window === 'undefined') return undefined;
  const Constructor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Constructor) return undefined;
  try { return context ??= new Constructor(); } catch { return undefined; }
}

/** A quiet loop, unlocked by the first user gesture and silenced when the tab hides. */
export function playDemoSound(kind: DemoSound, level: number): DemoAudio {
  const audio = audioContext();
  if (!audio) return { stop() {} };
  const gain = audio.createGain();
  const sources = new Set<AudioScheduledSourceNode>();
  const nodes = new Set<AudioNode>();
  gain.gain.value = document.hidden ? 0 : Math.max(0, Math.min(1, level)) * 0.1;
  gain.connect(audio.destination);
  let stopped = false;
  let next = audio.currentTime + 0.04;
  let step = 0;

  const remember = <T extends AudioScheduledSourceNode>(source: T, ...attached: AudioNode[]) => {
    sources.add(source);
    attached.forEach(node => nodes.add(node));
    source.onended = () => {
      sources.delete(source);
      source.disconnect();
      attached.forEach(node => { node.disconnect(); nodes.delete(node); });
    };
    return source;
  };
  const tone = (frequency: number, when: number, duration: number, volume = 0.5, type: OscillatorType = 'sine') => {
    const envelope = audio.createGain();
    envelope.gain.setValueAtTime(0, when);
    envelope.gain.linearRampToValueAtTime(volume, when + 0.012);
    envelope.gain.exponentialRampToValueAtTime(0.001, when + duration);
    envelope.connect(gain);
    const oscillator = remember(audio.createOscillator(), envelope);
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, when);
    oscillator.connect(envelope);
    oscillator.start(when);
    oscillator.stop(when + duration + 0.02);
  };

  if (kind === 'water') {
    // Seeded filtered noise makes a soft running-water bed without a downloaded recording.
    const buffer = audio.createBuffer(1, Math.floor(audio.sampleRate * 2), audio.sampleRate);
    const samples = buffer.getChannelData(0);
    let seed = 731;
    for (let i = 0; i < samples.length; i++) {
      seed = (seed * 16807) % 2147483647;
      samples[i] = (seed / 2147483647 * 2 - 1) * 0.45;
    }
    const filter = audio.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 1200; filter.Q.value = 0.45;
    filter.connect(gain);
    const source = remember(audio.createBufferSource(), filter);
    source.buffer = buffer; source.loop = true; source.connect(filter); source.start();
  }

  // A short original mallet phrase; sparse notes leave room for the call and its dialogue.
  const melody = [72, 76, 79, 0, 74, 77, 81, 79, 76, 0, 74, 71, 72, 67, 69, 0];
  const pump = () => {
    if (stopped) return;
    if (audio.state !== 'running' || document.hidden) { next = audio.currentTime + 0.04; return; }
    next = Math.max(next, audio.currentTime + 0.01);
    while (next < audio.currentTime + 0.2) {
      if (kind === 'title') {
        const note = melody[step % melody.length];
        if (note) tone(440 * 2 ** ((note - 69) / 12), next, 0.32, 0.45, 'triangle');
        if (step % 4 === 0) tone(step % 16 < 8 ? 130.81 : 146.83, next, 0.42, 0.2);
        next += 0.25;
      } else if (kind === 'water') {
        tone(850 + Math.sin(step * 1.7) * 210, next, 0.07, 0.14);
        next += 0.27 + (step % 3) * 0.1;
      } else if (kind === 'alarm') {
        tone(step % 2 === 0 ? 490 : 620, next, 0.55, 0.45);
        next += 0.8;
      } else {
        for (const offset of [0, 0.23]) {
          tone(660, next + offset, 0.15, 0.35);
          tone(880, next + offset, 0.15, 0.28);
        }
        next += 2.2;
      }
      step++;
    }
  };
  const unlock = () => { if (!stopped && audio.state === 'suspended') void audio.resume().then(pump).catch(() => {}); };
  const visibility = () => {
    gain.gain.cancelScheduledValues(audio.currentTime);
    gain.gain.setValueAtTime(document.hidden ? 0 : Math.max(0, Math.min(1, level)) * 0.1, audio.currentTime);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  document.addEventListener('visibilitychange', visibility);
  const timer = window.setInterval(pump, 100);
  pump();

  return { stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    document.removeEventListener('visibilitychange', visibility);
    gain.gain.cancelScheduledValues(audio.currentTime);
    gain.gain.setValueAtTime(0, audio.currentTime);
    for (const source of sources) { try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); }
    sources.clear();
    for (const node of nodes) node.disconnect();
    nodes.clear();
    gain.disconnect();
  } };
}
