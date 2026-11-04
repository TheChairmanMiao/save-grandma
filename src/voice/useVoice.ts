import { useCallback, useEffect, useRef, useState } from 'react';
import type { OpenAIRealtimeWebRTC, RealtimeItem, RealtimeSession } from '@openai/agents/realtime';
import { GRANDMA_SPEED, GRANDMA_VOICE, REALTIME_MODEL } from './model';
import { GRANDMA_GREETING, GRANDMA_VOICE_STYLE } from './persona';
import { onSpeaking, stopSpeaking } from './grandma-voice';

export type VoiceStatus = 'idle' | 'microphone' | 'connecting' | 'connected' | 'error';
export type VoiceMessage = { id: string; text: string };

const CONNECT_TIMEOUT_MS = 20_000;
const TOKEN_TIMEOUT_MS = 8_000;
// Closes ordinary abandoned calls. This client timer is not an enforceable spending cap.
const MAX_SESSION_MS = 6 * 60_000;

const audioSettings = (automaticInput: boolean) => ({
  input: {
    transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' },
    turnDetection: { type: 'semantic_vad' as const, eagerness: 'high' as const, createResponse: automaticInput, interruptResponse: automaticInput },
  },
  output: { voice: GRANDMA_VOICE, speed: GRANDMA_SPEED },
});

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
  const data = await response.json().catch(() => ({})) as { value?: unknown; relay?: boolean; code?: string };
  if (!response.ok || typeof data.value !== 'string' || !data.value) {
    if (data.code === 'DAILY_LIMIT') throw new Error('Today’s 10 AI calls are used up. Grandma can still play offline. Try again tomorrow.');
    if (data.code === 'BUSY') throw new Error('Grandma is on another AI call. Keep typing offline, or try connecting again in a few minutes.');
    throw new Error('Grandma’s AI is unavailable. Check the server connection and try again.');
  }
  return { value: data.value, relay: data.relay === true };
}

function lastMessage(history: RealtimeItem[], role: 'user' | 'assistant'): VoiceMessage | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i];
    if (item.type !== 'message' || item.role !== role || item.status === 'in_progress') continue;
    const text = item.content.map(part => 'transcript' in part ? part.transcript : 'text' in part ? part.text : '').filter(Boolean).join('\n');
    if (text) return { id: item.itemId, text };
  }
  return null;
}
const stopStream = (stream: MediaStream | null) => stream?.getTracks().forEach(track => track.stop());

type Attempt = {
  generation: number;
  abort: AbortController;
  audio: HTMLAudioElement;
  microphoneStream: MediaStream | null;
  silentStream: MediaStream | null;
  context: AudioContext | null;
  session: RealtimeSession | null;
  transport: OpenAIRealtimeWebRTC | null;
  ready: boolean;
  microphoneEnabled: boolean;
  microphoneGeneration: number;
  microphoneAbort: AbortController | null;
  microphoneRequest: Promise<boolean> | null;
  microphoneTarget: boolean;
  awaitingResponse: boolean;
  automaticInputEnabled: boolean | null;
  timer: ReturnType<typeof setTimeout> | null;
  tokenTimer: ReturnType<typeof setTimeout> | null;
  relayAuth?: string;
};

function syncAudioInput(attempt: Attempt, appMuted: boolean) {
  if (!attempt.ready || !attempt.transport || !attempt.session) return;
  const enabled = attempt.microphoneEnabled && !appMuted;
  // The installed transport fills omitted audio fields with defaults, so preserve the full audio configuration.
  if (attempt.automaticInputEnabled !== enabled) {
    attempt.transport.updateSessionConfig({ outputModalities: ['audio'], audio: audioSettings(enabled) });
    attempt.automaticInputEnabled = enabled;
  }
  attempt.session.mute(!enabled);
}

/** A real, silent track satisfies the SDK without requesting microphone permission. */
function silentStream(attempt: Attempt): MediaStream {
  if (attempt.silentStream) return attempt.silentStream;
  if (typeof AudioContext === 'undefined') throw new Error('This browser cannot start an audio call. Try a current desktop browser.');
  const context = new AudioContext();
  attempt.context = context;
  const stream = context.createMediaStreamDestination().stream;
  attempt.silentStream = stream;
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('This browser could not create the call’s audio track.');
  track.enabled = false;
  // This function is called synchronously from the Start/mic click, before network awaits.
  void context.resume().catch(() => {});
  return stream;
}

/** One conversation shared by typed messages and optional microphone input. */
export function useVoice() {
  const active = useRef<Attempt | null>(null);
  const generation = useRef(0);
  const connecting = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
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
  const [responding, setResponding] = useState(false);
  const [microphoneEnabled, setMicrophoneEnabledState] = useState(false);
  const [assistantMessage, setAssistantMessage] = useState<VoiceMessage | null>(null);
  const [userMessage, setUserMessage] = useState<VoiceMessage | null>(null);

  const isCurrent = (attempt: Attempt) => mounted.current && active.current === attempt && generation.current === attempt.generation;
  const clearConnection = useCallback(() => {
    const attempt = active.current;
    active.current = null;
    generation.current++;
    connecting.current = null;
    holdOutputMuted.current = false;
    stopSpeaking();
    if (mounted.current) { setResponding(false); setMicrophoneEnabledState(false); }
    if (!attempt) return;
    attempt.ready = false;
    attempt.abort.abort();
    attempt.microphoneAbort?.abort();
    if (attempt.timer) clearTimeout(attempt.timer);
    if (attempt.tokenTimer) clearTimeout(attempt.tokenTimer);
    try { attempt.session?.close(); } catch { /* Still release caller-owned media resources. */ }
    if (attempt.relayAuth) {
      // This is a single-use application call token. The provider key never reaches the browser.
      void fetch('/api/realtime-close', { method: 'POST', headers: { Authorization: `Bearer ${attempt.relayAuth}` }, keepalive: true }).catch(() => {});
      attempt.relayAuth = undefined;
    }
    stopStream(attempt.microphoneStream); attempt.microphoneStream = null;
    stopStream(attempt.silentStream); attempt.silentStream = null;
    if (attempt.context) { void attempt.context.close().catch(() => {}); attempt.context = null; }
    attempt.audio.pause(); attempt.audio.srcObject = null; attempt.audio.src = '';
  }, []);

  const failConnection = useCallback((attempt: Attempt, message: string) => {
    if (!isCurrent(attempt)) return;
    clearConnection();
    setStatus('error'); setError(message); setSpeaking(false); setMuted(false);
  }, [clearConnection]);
  const disconnect = useCallback(({ resetCaptions = true }: { resetCaptions?: boolean } = {}) => {
    clearConnection();
    if (!mounted.current) return;
    mutedValue.current = false;
    setStatus('idle'); setError(''); setSpeaking(false); setMuted(false);
    if (resetCaptions) { setGrandmaSaid(''); setYouSaid(''); setAssistantMessage(null); setUserMessage(null); }
  }, [clearConnection]);

  const setMicrophoneEnabled = useCallback((enabled: boolean): Promise<boolean> => {
    const attempt = active.current;
    if (!attempt?.ready || !attempt.session) return Promise.resolve(false);
    if (attempt.microphoneRequest && attempt.microphoneTarget === enabled) return attempt.microphoneRequest;
    if (!attempt.microphoneRequest && attempt.microphoneEnabled === enabled) return Promise.resolve(enabled);
    attempt.microphoneAbort?.abort();
    const abort = new AbortController();
    attempt.microphoneAbort = abort;
    attempt.microphoneTarget = enabled;
    const microphoneGeneration = ++attempt.microphoneGeneration;
    const current = () => isCurrent(attempt) && attempt.ready && attempt.microphoneGeneration === microphoneGeneration && !abort.signal.aborted;
    setError('');
    let requested: Promise<MediaStream>;
    try {
      if (enabled) {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs HTTPS or localhost.');
        // Called immediately from the explicit mic-button click, never from typed input.
        requested = navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
          if (!current()) stopStream(stream);
          return stream;
        });
      } else {
        attempt.microphoneEnabled = false;
        syncAudioInput(attempt, mutedValue.current);
        setMicrophoneEnabledState(false); setMuted(true);
        requested = Promise.resolve(silentStream(attempt));
      }
    } catch {
      setError('The microphone could not be enabled. You can still chat by typing.');
      return Promise.resolve(false);
    }
    const pending = (async () => {
      let stream: MediaStream | null = null;
      try {
        stream = await abortable(requested, abort.signal);
        if (!current()) { if (enabled) stopStream(stream); return false; }
        if (enabled) attempt.microphoneStream = stream;
        const track = stream.getAudioTracks()[0];
        const sender = attempt.transport?.connectionState.peerConnection?.getSenders().find(candidate => candidate.track?.kind === 'audio');
        if (!track || !sender) throw new Error('Call audio sender is unavailable.');
        await abortable(sender.replaceTrack(track), abort.signal);
        if (!current()) { if (enabled) stopStream(stream); return false; }
        if (!enabled) { stopStream(attempt.microphoneStream); attempt.microphoneStream = null; }
        attempt.microphoneEnabled = enabled;
        syncAudioInput(attempt, mutedValue.current);
        setMicrophoneEnabledState(enabled); setMuted(mutedValue.current || !enabled);
        return enabled;
      } catch {
        if (enabled && stream && attempt.microphoneStream === stream) { stopStream(stream); attempt.microphoneStream = null; }
        if (current()) {
          if (!enabled) { stopStream(attempt.microphoneStream); attempt.microphoneStream = null; }
          setError(enabled ? 'Microphone access was blocked or interrupted. You can still chat by typing.' : 'The microphone is off. You can still chat by typing.');
        }
        return false;
      }
    })();
    attempt.microphoneRequest = pending;
    void pending.finally(() => {
      if (attempt.microphoneRequest === pending) { attempt.microphoneRequest = null; attempt.microphoneAbort = null; }
    });
    return pending;
  }, []);

  const connect = useCallback(({ microphone = true }: { microphone?: boolean } = {}): Promise<void> => {
    if (connecting.current) return connecting.current;
    if (active.current?.ready) return microphone ? setMicrophoneEnabled(true).then(() => {}) : Promise.resolve();
    setError(''); setGrandmaSaid(''); setYouSaid(''); setAssistantMessage(null); setUserMessage(null);
    setSpeechStarted(0); setSpeechEnded(0); setResponding(false);
    const audio = document.createElement('audio');
    audio.autoplay = true; audio.muted = holdOutputMuted.current;
    void audio.play().catch(() => {});
    const attempt: Attempt = {
      generation: ++generation.current, abort: new AbortController(), audio,
      microphoneStream: null, silentStream: null, context: null, session: null, transport: null, ready: false,
      microphoneEnabled: false, microphoneGeneration: 0, microphoneAbort: null, microphoneRequest: null,
      microphoneTarget: microphone, awaitingResponse: false, automaticInputEnabled: null, timer: null, tokenTimer: null,
    };
    active.current = attempt;
    setStatus('connecting');
    // Create/unlock the silent audio graph in the click gesture. It never opens the microphone.
    if (!microphone) {
      try { silentStream(attempt); }
      catch (cause) {
        failConnection(attempt, cause instanceof Error ? cause.message : 'This browser could not start the audio call.');
        return Promise.resolve();
      }
    }
    attempt.timer = setTimeout(() => failConnection(attempt, 'Grandma’s AI connection timed out. Try connecting again.'), CONNECT_TIMEOUT_MS);
    attempt.tokenTimer = setTimeout(() => {
      if (isCurrent(attempt)) failConnection(attempt, 'Grandma’s AI server is taking too long to connect. Try again.');
    }, TOKEN_TIMEOUT_MS);

    const pending = (async () => {
      try {
        const credentials = await abortable(fetchClientSecret(attempt.abort.signal), attempt.abort.signal);
        if (credentials.relay) attempt.relayAuth = credentials.value;
        if (attempt.tokenTimer) { clearTimeout(attempt.tokenTimer); attempt.tokenTimer = null; }
        if (!isCurrent(attempt)) return;
        const [{ OpenAIRealtimeWebRTC, RealtimeSession }, { grandmaAgent }] = await abortable(
          Promise.all([import('@openai/agents/realtime'), import('./grandma')]), attempt.abort.signal,
        );
        if (!isCurrent(attempt)) return;
        let stream: MediaStream;
        if (microphone) {
          if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access needs HTTPS or localhost. You can connect using typed chat.');
          setStatus('microphone');
          const requestedStream = navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
            if (!isCurrent(attempt)) stopStream(stream);
            return stream;
          });
          try { stream = await abortable(requestedStream, attempt.abort.signal); }
          catch (cause) {
            if (!isCurrent(attempt)) return;
            throw new Error('Microphone access was blocked. Connect using typed chat, or allow the microphone and retry.', { cause });
          }
          if (!isCurrent(attempt)) { stopStream(stream); return; }
          attempt.microphoneStream = stream;
          attempt.microphoneEnabled = true;
        } else stream = silentStream(attempt);
        setStatus('connecting');
        const transport = new OpenAIRealtimeWebRTC({ audioElement: audio, mediaStream: stream });
        attempt.transport = transport;
        const automaticInput = attempt.microphoneEnabled && !mutedValue.current;
        attempt.automaticInputEnabled = automaticInput;
        const s = new RealtimeSession(grandmaAgent, {
          transport, model: REALTIME_MODEL,
          config: {
            outputModalities: ['audio'],
            audio: audioSettings(automaticInput),
          },
        });
        attempt.session = s;
        transport.on('connection_change', state => {
          if (state === 'disconnected') failConnection(attempt, 'Grandma’s AI call disconnected. Try connecting again.');
        });
        s.on('history_updated', history => {
          if (!isCurrent(attempt)) return;
          const assistant = lastMessage(history, 'assistant'); const user = lastMessage(history, 'user');
          setGrandmaSaid(assistant?.text ?? ''); setYouSaid(user?.text ?? '');
          setAssistantMessage(old => old?.id === assistant?.id && old?.text === assistant?.text ? old : assistant);
          setUserMessage(old => old?.id === user?.id && old?.text === user?.text ? old : user);
        });
        s.on('transport_event', event => {
          if (!isCurrent(attempt)) return;
          const acceptsSpeech = attempt.microphoneEnabled && !mutedValue.current;
          if (event.type === 'input_audio_buffer.speech_started' && acceptsSpeech) setSpeechStarted(n => n + 1);
          if (event.type === 'input_audio_buffer.committed' && acceptsSpeech) { attempt.awaitingResponse = true; setResponding(true); setSpeechEnded(n => n + 1); }
          if (event.type === 'response.created') { attempt.awaitingResponse = false; setResponding(true); }
          if (event.type === 'response.done' && !attempt.awaitingResponse) setResponding(false);
        });
        s.on('audio_start', () => { if (isCurrent(attempt)) setSpeaking(true); });
        s.on('audio_stopped', () => { if (isCurrent(attempt)) setSpeaking(false); });
        s.on('audio_interrupted', () => { if (isCurrent(attempt)) setSpeaking(false); });
        s.on('error', () => failConnection(attempt, 'Grandma’s AI call was interrupted. Try connecting again.'));
        await abortable(s.connect({ apiKey: credentials.value, ...(credentials.relay ? { url: new URL('/api/realtime-call', window.location.origin).href } : {}) }), attempt.abort.signal);
        if (!isCurrent(attempt)) { s.close(); return; }
        if (attempt.timer) clearTimeout(attempt.timer);
        attempt.ready = true;
        syncAudioInput(attempt, mutedValue.current);
        setMicrophoneEnabledState(attempt.microphoneEnabled); setMuted(mutedValue.current || !attempt.microphoneEnabled);
        setStatus('connected');
        attempt.timer = setTimeout(() => { if (isCurrent(attempt)) disconnect({ resetCaptions: false }); }, MAX_SESSION_MS);
      } catch (cause) {
        if (!isCurrent(attempt)) return;
        failConnection(attempt, cause instanceof Error && /^(Microphone|Today’s|Grandma is on another)/.test(cause.message) ? cause.message : 'Grandma’s AI is unavailable. Check the server connection and try again.');
      }
    })();
    connecting.current = pending;
    void pending.finally(() => { if (connecting.current === pending) connecting.current = null; });
    return pending;
  }, [disconnect, failConnection, setMicrophoneEnabled]);

  const setMute = useCallback((value: boolean) => {
    mutedValue.current = value;
    const attempt = active.current;
    if (attempt) {
      try { syncAudioInput(attempt, value); }
      catch { failConnection(attempt, 'Grandma’s audio settings could not update. Try connecting again.'); }
    }
    setMuted(value || !attempt?.microphoneEnabled);
  }, [failConnection]);
  const hush = useCallback(() => {
    const attempt = active.current;
    stopSpeaking(); setSpeaking(false); setResponding(false);
    if (attempt) {
      attempt.awaitingResponse = false;
      attempt.session?.interrupt();
      // Clear queued output through the SDK; do not hide the next response with a timed mute.
      attempt.audio.muted = holdOutputMuted.current;
    }
  }, []);
  const sendText = useCallback((text: string): boolean => {
    const attempt = active.current;
    const trimmed = text.trim();
    if (!trimmed || !attempt?.ready || !attempt.session) return false;
    try {
      hush();
      attempt.awaitingResponse = true; setResponding(true);
      // sendMessage creates the user item AND requests one response. Do not call respond() too.
      attempt.session.sendMessage(trimmed);
      return true;
    } catch {
      failConnection(attempt, 'Your message could not reach Grandma’s AI. Try connecting again.');
      return false;
    }
  }, [failConnection, hush]);
  const greet = useCallback(() => {
    const attempt = active.current; if (!attempt?.ready || !attempt.session) return;
    attempt.awaitingResponse = true; setResponding(true);
    attempt.session.transport.sendEvent({ type: 'response.create', response: {
      instructions: `${GRANDMA_VOICE_STYLE}\nOpen the call by saying exactly: "${GRANDMA_GREETING}" Use affectionate exasperation and a little urgency. Do not call tools or add another line. Then stop and listen.`,
    } });
  }, []);
  const setOutputMuted = useCallback((value: boolean) => {
    holdOutputMuted.current = value;
    const attempt = active.current;
    if (attempt) attempt.audio.muted = value;
    if (value && attempt?.session) { stopSpeaking(); setSpeaking(false); }
  }, []);
  const notify = useCallback((text: string) => { sendText(text); }, [sendText]);
  const sayLine = useCallback((text: string) => {
    const attempt = active.current; if (!attempt?.ready || !attempt.session) return;
    hush(); attempt.awaitingResponse = true; setResponding(true);
    attempt.session.transport.sendEvent({ type: 'response.create', response: { instructions: `${GRANDMA_VOICE_STYLE}\nSay exactly this line: "${text}" Do not call tools or add commentary. Then stop speaking.` } });
  }, [hush]);

  useEffect(() => onSpeaking(value => { if (mounted.current) setSpeaking(value); }), []);
  useEffect(() => {
    mounted.current = true;
    const leave = () => disconnect();
    if (typeof window !== 'undefined') window.addEventListener('pagehide', leave);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('pagehide', leave);
      mounted.current = false; clearConnection();
    };
  }, [clearConnection, disconnect]);
  // Compatibility for callers that explicitly request a reply; microphone turns use automatic VAD.
  const respond = useCallback(() => {
    const attempt = active.current; if (!attempt?.ready || !attempt.session) return;
    attempt.awaitingResponse = true; setResponding(true);
    attempt.session.transport.sendEvent({ type: 'response.create' });
  }, []);

  return { status, error, grandmaSaid, youSaid, assistantMessage, userMessage, speaking, responding, microphoneEnabled, speechStarted, speechEnded, muted, connect, disconnect, setMicrophoneEnabled, sendText, setMute, setOutputMuted, notify, sayLine, greet, respond, hush };
}
