import { useCallback, useEffect, useRef, useState } from 'react';
import type { RealtimeItem, RealtimeSession } from '@openai/agents/realtime';
import { GRANDMA_SPEED, GRANDMA_VOICE, REALTIME_MODEL } from './model';
import { GRANDMA_GREETING, GRANDMA_VOICE_STYLE } from './persona';
import { onSpeaking, stopSpeaking } from './grandma-voice';

export type VoiceStatus = 'idle' | 'microphone' | 'connecting' | 'connected' | 'error';

const CONNECT_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 8_000;
// Closes ordinary abandoned calls. This client timer is not an enforceable spending cap.
const MAX_SESSION_MS = 6 * 60_000;

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new DOMException('Connection cancelled', 'AbortError'));
    if (signal.aborted) { abort(); void pending.catch(() => {}); return; }
    signal.addEventListener('abort', abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function fetchClientSecret(signal: AbortSignal) {
  const response = await fetch('/api/realtime-token', { method: 'POST', signal });
  const data = await response.json().catch(() => ({})) as { value?: unknown };
  if (!response.ok || typeof data.value !== 'string' || !data.value) {
    throw new Error('Voice is unavailable for this demo. You can keep playing by typing.');
  }
  return data.value;
}

function lastTranscript(history: RealtimeItem[], role: 'user' | 'assistant') {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type !== 'message' || item.role !== role) continue;
    if ('status' in item && item.status === 'in_progress') continue;
    for (const part of item.content) {
      const text = 'transcript' in part ? part.transcript : 'text' in part ? part.text : undefined;
      if (text) return text;
    }
  }
  return '';
}

type Attempt = {
  generation: number;
  abort: AbortController;
  audio: HTMLAudioElement;
  stream: MediaStream | null;
  session: RealtimeSession | null;
  timer: ReturnType<typeof setTimeout> | null;
  tokenTimer: ReturnType<typeof setTimeout> | null;
};

/** One Realtime voice session with Grandma, connected to the shared game controller through tools. */
export function useVoice() {
  const active = useRef<Attempt | null>(null);
  const generation = useRef(0);
  const connecting = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const responding = useRef(false);
  const mutedValue = useRef(false);
  const holdOutputMuted = useRef(false);
  const [status, setStatus] = useState<VoiceStatus>('idle');
  const [error, setError] = useState('');
  const [grandmaSaid, setGrandmaSaid] = useState('');
  const [youSaid, setYouSaid] = useState('');
  const [speaking, setSpeaking] = useState(false);
  const [speechEnded, setSpeechEnded] = useState(0);
  const [speechStarted, setSpeechStarted] = useState(0);
  const [muted, setMuted] = useState(false);

  const isCurrent = (attempt: Attempt) => mounted.current && active.current === attempt && generation.current === attempt.generation;
  const clearConnection = useCallback(() => {
    const attempt = active.current;
    active.current = null;
    generation.current++;
    connecting.current = null;
    responding.current = false;
    holdOutputMuted.current = false;
    stopSpeaking();
    if (!attempt) return;
    attempt.abort.abort();
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.tokenTimer) clearTimeout(attempt.tokenTimer);
    // Invalidate callbacks before closing; the SDK emits connection_change while closing.
    try { attempt.session?.close(); } catch { /* Continue releasing caller-owned resources. */ }
    attempt.stream?.getTracks().forEach(track => track.stop());
    attempt.audio.pause();
    attempt.audio.srcObject = null;
    attempt.audio.src = '';
  }, []);

  const disconnect = useCallback(({ resetCaptions = true }: { resetCaptions?: boolean } = {}) => {
    clearConnection();
    if (!mounted.current) return;
    mutedValue.current = false;
    setStatus('idle'); setError(''); setSpeaking(false); setMuted(false);
    if (resetCaptions) { setGrandmaSaid(''); setYouSaid(''); }
  }, [clearConnection]);

  const connect = useCallback((): Promise<void> => {
    if (connecting.current) return connecting.current;
    if (active.current) return Promise.resolve();
    setError(''); setGrandmaSaid(''); setYouSaid('');
    setSpeechStarted(0); setSpeechEnded(0);
    // Unlock output inside the click gesture, before token/network work. No microphone prompt yet.
    const audio = document.createElement('audio');
    audio.autoplay = true;
    audio.muted = holdOutputMuted.current;
    void audio.play().catch(() => {});
    const attempt: Attempt = {
      generation: ++generation.current, abort: new AbortController(), audio,
      stream: null, session: null, timer: null, tokenTimer: null,
    };
    active.current = attempt;
    setStatus('connecting');
    const fail = (message: string) => {
      if (!isCurrent(attempt)) return;
      clearConnection();
      setStatus('error'); setError(message); setSpeaking(false); setMuted(false);
    };
    attempt.timer = setTimeout(() => fail('Voice connection timed out. You can type or try the microphone again.'), CONNECT_TIMEOUT_MS);
    attempt.tokenTimer = setTimeout(() => {
      if (isCurrent(attempt)) fail('Voice is taking too long to connect. You can keep playing by typing.');
    }, TOKEN_TIMEOUT_MS);

    const pending = (async () => {
      try {
        const secret = await abortable(fetchClientSecret(attempt.abort.signal), attempt.abort.signal);
        if (attempt.tokenTimer) { clearTimeout(attempt.tokenTimer); attempt.tokenTimer = null; }
        if (!isCurrent(attempt)) return;
        // Avoid downloading the voice SDK/agent for a typed-only demo or unavailable backend.
        const [{ OpenAIRealtimeWebRTC, RealtimeSession }, { grandmaAgent }] = await abortable(
          Promise.all([import('@openai/agents/realtime'), import('./grandma')]), attempt.abort.signal,
        );
        if (!isCurrent(attempt)) return;
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs HTTPS or localhost. You can keep playing by typing.');
        setStatus('microphone');
        const requestedStream = navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
          // Permission prompts cannot be aborted. Dispose a late stream after cancellation/retry.
          if (!isCurrent(attempt)) stream.getTracks().forEach(track => track.stop());
          return stream;
        });
        let stream: MediaStream;
        try { stream = await abortable(requestedStream, attempt.abort.signal); }
        catch (cause) {
          if (!isCurrent(attempt)) return;
          throw new Error('Microphone access was blocked. You can type, or allow the microphone and retry.', { cause });
        }
        if (!isCurrent(attempt)) { stream.getTracks().forEach(track => track.stop()); return; }
        attempt.stream = stream;
        setStatus('connecting');
        const transport = new OpenAIRealtimeWebRTC({ audioElement: audio, mediaStream: stream });
        const s = new RealtimeSession(grandmaAgent, {
          transport, model: REALTIME_MODEL,
          config: {
            outputModalities: ['audio'],
            audio: {
              input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' }, turnDetection: { type: 'semantic_vad', eagerness: 'high', createResponse: false, interruptResponse: false } },
              output: { voice: GRANDMA_VOICE, speed: GRANDMA_SPEED },
            },
          },
        });
        attempt.session = s;
        transport.on('connection_change', state => {
          if (state === 'disconnected' && isCurrent(attempt)) fail('The voice call disconnected. You can type or reconnect the microphone.');
        });
        s.on('history_updated', history => {
          if (!isCurrent(attempt)) return;
          setGrandmaSaid(lastTranscript(history, 'assistant'));
          setYouSaid(lastTranscript(history, 'user'));
        });
        s.on('transport_event', event => {
          if (!isCurrent(attempt)) return;
          if (event.type === 'input_audio_buffer.speech_started') setSpeechStarted(n => n + 1);
          if (event.type === 'input_audio_buffer.committed') setSpeechEnded(n => n + 1);
          if (event.type === 'response.created') responding.current = true;
          if (event.type === 'response.done') responding.current = false;
        });
        s.on('audio_start', () => { if (isCurrent(attempt)) setSpeaking(true); });
        s.on('audio_stopped', () => { if (isCurrent(attempt)) setSpeaking(false); });
        s.on('audio_interrupted', () => { if (isCurrent(attempt)) setSpeaking(false); });
        s.on('error', () => fail('Voice was interrupted. You can keep playing by typing or reconnect the microphone.'));
        await abortable(s.connect({ apiKey: secret }), attempt.abort.signal);
        if (!isCurrent(attempt)) { s.close(); return; }
        if (attempt.timer) clearTimeout(attempt.timer);
        s.mute(mutedValue.current);
        setStatus('connected');
        attempt.timer = setTimeout(() => {
          if (isCurrent(attempt)) disconnect({ resetCaptions: false });
        }, MAX_SESSION_MS);
      } catch (cause) {
        if (!isCurrent(attempt)) return;
        fail(cause instanceof Error && cause.message.startsWith('Microphone') ? cause.message : 'Voice is unavailable right now. You can keep playing by typing.');
      }
    })();
    connecting.current = pending;
    void pending.finally(() => { if (connecting.current === pending) connecting.current = null; });
    return pending;
  }, [clearConnection, disconnect]);

  const setMute = useCallback((value: boolean) => {
    mutedValue.current = value;
    active.current?.session?.mute(value);
    setMuted(value);
  }, []);
  const greet = useCallback(() => {
    active.current?.session?.transport.sendEvent({ type: 'response.create', response: {
      instructions: `${GRANDMA_VOICE_STYLE}\nOpen the call by saying exactly: "${GRANDMA_GREETING}" Use affectionate exasperation and a little urgency. Do not call tools or add another line. Then stop and listen.`,
    } });
  }, []);
  const hush = useCallback(() => {
    const attempt = active.current;
    stopSpeaking();
    setSpeaking(false);
    attempt?.session?.interrupt();
    if (attempt) {
      attempt.audio.muted = true;
      setTimeout(() => { if (isCurrent(attempt) && !holdOutputMuted.current) attempt.audio.muted = false; }, 600);
    }
  }, []);
  const setOutputMuted = useCallback((value: boolean) => {
    holdOutputMuted.current = value;
    const attempt = active.current;
    if (attempt) attempt.audio.muted = value;
    if (value && attempt?.session) {
      stopSpeaking();
      setSpeaking(false);
    }
  }, []);
  const notify = useCallback((text: string) => { active.current?.session?.sendMessage(text); }, []);
  const sayLine = useCallback((text: string) => {
    const s = active.current?.session; if (!s) return;
    stopSpeaking();
    s.interrupt();
    s.transport.sendEvent({ type: 'response.create', response: { instructions: `${GRANDMA_VOICE_STYLE}\nSay exactly this line: "${text}" Do not call tools or add commentary. Then stop speaking.` } });
  }, []);

  useEffect(() => onSpeaking(value => { if (mounted.current) setSpeaking(value); }), []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; clearConnection(); };
  }, [clearConnection]);
  const respond = useCallback(() => {
    if (responding.current) return;
    active.current?.session?.transport.sendEvent({ type: 'response.create' });
  }, []);

  return { status, error, grandmaSaid, youSaid, speaking, speechStarted, speechEnded, muted, connect, disconnect, setMute, setOutputMuted, notify, sayLine, greet, respond, hush };
}
