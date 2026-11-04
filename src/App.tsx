import { useEffect, useRef, useState, type FormEvent } from 'react';
import { gameCommands, gameController, simulation } from './game/session';
import type { Action } from './game/types';
import Scene from './view/Scene';
import StartScreen from './view/StartScreen';
import Intro, { GREETING, RULES } from './view/Intro';
import Outro, { OUTRO_LINES } from './view/Outro';
import { speak, stopSpeaking } from './voice/grandma-voice';
import { EXAMPLES } from './voice/text-commands';
import { OfflineGrandma } from './voice/offline-grandma';
import { useVoice } from './voice/useVoice';
import { useIntroMusic } from './view/intro-music';
import { useLeakSound } from './view/leak-sound';
import { useMaydaySiren } from './view/mayday-sound';
import { TUNING } from './game/config';

const MAYDAY_SECONDS = 60;
const VOICE_AVAILABLE = import.meta.env.VITE_VOICE_AVAILABLE === 'true';

type Line = { id: string; who: 'you' | 'grandma' | 'note'; text: string };
const line = (who: Line['who'], text: string): Line => ({ id: crypto.randomUUID(), who, text });

export default function App() {
  const [world, setWorld] = useState(() => simulation.readState());
  const [started, setStarted] = useState(false);
  const [intro, setIntro] = useState<'pending' | 'playing' | 'done'>('pending');
  const [lines, setLines] = useState<Line[]>([]);
  const [draft, setDraft] = useState('');
  const [helpOpen, setHelpOpen] = useState(false);
  const [spokenReplies, setSpokenReplies] = useState(true);
  const speechPreference = useRef(spokenReplies);
  speechPreference.current = spokenReplies;
  const [offline] = useState(() => new OfflineGrandma());
  const actionById = useRef(new Map<string, Action>());
  const knownRun = useRef(world.runId);
  const seenMessages = useRef(new Set<string>());
  const pendingTyped = useRef<string[]>([]);
  const transcript = useRef<HTMLDivElement>(null);
  // Yao's realtime voice agent. Connects when Grandma's greeting begins; typed text stays as a fallback.
  const voice = useVoice();
  const voiceState = useRef(voice);
  voiceState.current = voice;
  useIntroMusic(started ? 'off' : 'title');
  // Water keeps dripping as long as the leak flows during a live call; louder after a wrong turn.
  const ended = world.stage === 'won' || world.stage === 'lost';
  useLeakSound(world.stage === 'running' && world.leakRate > 0, world.leakRate / TUNING.initialLeakPerSecond, ended);
  // Mayday: in the final minute before flooding, the bathroom flashes red and a siren sounds.
  const secondsLeft = world.leakRate > 0 ? (TUNING.floodThreshold - world.water) / world.leakRate : Infinity;
  const mayday = world.stage === 'running' && secondsLeft <= MAYDAY_SECONDS;
  useMaydaySiren(mayday, ended);
  const { setMute } = voice;
  const say = (who: Line['who'], text: string) => setLines(old => [...old, line(who, text)].slice(-40));
  const speakOffline = (text: string) => { stopSpeaking(); if (speechPreference.current) void speak(text); };
  useEffect(() => gameController.subscribe(event => {
    if (event.type === 'state_changed') {
      if (event.runId !== knownRun.current) {
        knownRun.current = event.runId; offline.reset(); actionById.current.clear();
      }
      setWorld(simulation.readState());
    }
    if (event.type === 'action_queued') actionById.current.set(event.actionId, event.action);
    if (event.type === 'action_result') {
      const action = actionById.current.get(event.result.actionId);
      actionById.current.delete(event.result.actionId);
      if (voiceState.current.status === 'connected' || event.result.status === 'cancelled' || !action) return;
      const observation = gameController.getObservation();
      const reply = offline.react(action, event.result, observation);
      say('grandma', reply);
      // Speak the latest result rather than building an obsolete queue during compound actions.
      if (event.result.status !== 'completed' || !observation.queuedActions) speakOffline(reply);
    }
  }), []);
  useEffect(() => {
    let last = performance.now();
    const timer = window.setInterval(() => {
      const now = performance.now();
      simulation.advance((now - last) / 1000);
      last = now;
    }, 50);
    // A hidden tab pauses the call so browser throttling cannot decide a game.
    const visibility = () => { if (document.hidden) gameController.pause(); last = performance.now(); };
    document.addEventListener('visibilitychange', visibility);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
  }, []);
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'smooth' }); }, [lines]);

  const running = world.stage === 'running';
  const terminal = world.stage === 'won' || world.stage === 'lost';
  const callLive = running && intro === 'done';
  const busy = voice.speaking || voice.responding || !!world.active || !!world.queue.length;
  const currentTurn = busy ? 'grandma' : 'player';
  useEffect(() => { setMute(!callLive); }, [callLive, setMute]);
  useEffect(() => { voice.setOutputMuted(!spokenReplies); }, [spokenReplies, voice.status, voice.setOutputMuted]);
  // Speech onset interrupts obsolete work; VAD creates the next response when the caller finishes.
  useEffect(() => {
    if (!voice.speechStarted || !callLive) return;
    gameCommands.interrupt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.speechStarted]);
  // Win and loss each have one fixed line from Grandma, spoken live when connected, synthesized otherwise.
  useEffect(() => {
    if (!terminal) return;
    const text = OUTRO_LINES[world.stage as 'won' | 'lost'];
    stopSpeaking();
    if (voice.status === 'connected') voice.sayLine(text); else if (speechPreference.current) void speak(text);
    say('grandma', text);
    const close = window.setTimeout(voice.disconnect, 7000);
    return () => clearTimeout(close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);
  useEffect(() => {
    if (world.stage !== 'paused') return;
    // Keep the same paid conversation through help/tab pauses; mute input and stop stale output.
    voice.hush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.stage, voice.hush]);
  const voiceLabel = voice.status === 'connected' ? (voice.microphoneEnabled ? 'Turn off microphone and keep typing' : 'Talk to Grandma') : voice.status === 'microphone' ? 'Allow the microphone…' : voice.status === 'connecting' ? 'Connecting natural voice…' : 'Connect natural voice';
  const onMic = () => {
    if (voice.status !== 'connected') { void voice.connect({ microphone: false }); return; }
    void voice.setMicrophoneEnabled(!voice.microphoneEnabled);
  };
  useEffect(() => {
    const message = voice.assistantMessage;
    if (!message || seenMessages.current.has(message.id)) return;
    seenMessages.current.add(message.id);
    setLines(old => old.at(-1)?.who === 'grandma' && old.at(-1)?.text === message.text ? old : [...old, line('grandma', message.text)].slice(-40));
  }, [voice.assistantMessage]);
  useEffect(() => {
    const message = voice.userMessage;
    if (!message || seenMessages.current.has(message.id)) return;
    seenMessages.current.add(message.id);
    const optimistic = pendingTyped.current.indexOf(message.text);
    if (optimistic >= 0) pendingTyped.current.splice(optimistic, 1); else say('you', message.text);
  }, [voice.userMessage]);
  useEffect(() => {
    if (voice.status !== 'connected') pendingTyped.current = [];
  }, [voice.status]);
  const elapsed = `${Math.floor(world.elapsed / 60).toString().padStart(2, '0')}:${Math.floor(world.elapsed % 60).toString().padStart(2, '0')}`;

  // Connected speech and typing share the same conversational agent and native audio output.
  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !callLive) return;
    setDraft('');
    say('you', text);
    if (voice.status === 'connected') {
      gameCommands.interrupt(); stopSpeaking();
      pendingTyped.current.push(text);
      if (voice.sendText(text)) return;
      pendingTyped.current.pop();
    }
    if (/^(help|\?)$/i.test(text)) { say('note', `Try: ${EXAMPLES.join(' · ')}`); return; }
    const planned = offline.plan(text, gameController.getObservation());
    if (planned.interrupt !== false) { gameCommands.interrupt(); stopSpeaking(); }
    if (planned.reply) { say('grandma', planned.reply); speakOffline(planned.reply); }
    if (!planned.steps.length) return;
    const turn = gameCommands.beginTurn();
    void gameCommands.submit(turn.token, planned.steps).then(outcome => {
      if (outcome.status === 'rejected') say('note', outcome.code === 'NOT_RUNNING' ? 'Answer the call first.' : `Could not send that (${outcome.code}).`);
    });
  };
  const startCall = () => {
    gameController.start();
    if (document.hidden) gameController.pause();
  };
  const restart = () => {
    const microphone = voice.microphoneEnabled;
    voice.disconnect(); gameCommands.interrupt(); gameController.reset(); startCall();
    setLines([]); setDraft(''); setHelpOpen(false); offline.reset(); seenMessages.current.clear(); pendingTyped.current = [];
    if (VOICE_AVAILABLE) void voice.connect({ microphone }).then(() => voice.greet());
  };
  const resume = () => {
    setHelpOpen(false); gameController.resume();
  };

  return <>
    {/* Connect inside the click so the mic prompt and audio unlock happen in the user gesture. */}
    {!started && <StartScreen voiceAvailable={VOICE_AVAILABLE} onStart={() => { setStarted(true); setIntro('playing'); if (VOICE_AVAILABLE) void voice.connect({ microphone: false }); }} />}
    <div className="stage" inert={!started}>
      <div className={`phone ${mayday ? 'mayday' : ''}`} data-testid="phone" data-camera-mode={world.phone.mode} data-grandma-facing={world.grandma.yaw} data-voice-speaking={voice.speaking} data-voice-responding={voice.responding}>
        {/* Grandma's hands are not steady: CSS shake layers scale with what she is doing. */}
        <div className={`camera-view ${world.phone.placement === 'hand' && running ? 'handheld' : ''} ${world.active?.to ? 'walking' : ''} stress-${gameController.getObservation().stressBand}`} data-testid="camera-view"><Scene world={world} /></div>

        <div className="call-time"><span className={`dot ${running ? 'live' : ''}`} />{elapsed}</div>
        {intro === 'done' && running && <button type="button" className="call-help" onClick={() => { setHelpOpen(true); gameController.pause(); }}>How to play</button>}
        {intro === 'done' && running && <div className={`turn-banner ${currentTurn}`} role="status">
          <span className="turn-label">{voice.speaking ? 'Grandma is talking · you can interrupt' : world.active ? 'Grandma is on it…' : voice.responding ? 'Grandma is thinking…' : 'Tell Grandma what to do'}</span>
        </div>}
        {intro === 'playing' && <Intro voice={voice} onGreeting={live => { if (!live) say('grandma', GREETING); }} onDone={startCall} onFinished={() => setIntro('done')} />}
        {world.stage === 'paused' && <div className="call-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title"><div className="call-card compact"><span className="eyebrow">TAKE A BREATH</span><h2 id="pause-title">{helpOpen ? 'How to save Grandma' : 'Call paused.'}</h2><p>The water and Grandma’s actions are paused.</p>{helpOpen && <ul className="help-rules">{RULES.map(rule => <li key={rule}>{rule}</li>)}</ul>}<button autoFocus className="primary" onClick={resume}>Resume call ↗</button></div></div>}
        {terminal && <Outro outcome={world.stage as 'won' | 'lost'} onRestart={restart} />}

        <div className="call-bottom" inert={!running || intro !== 'done'}>
          <div className="transcript" ref={transcript} role="log" aria-live="polite" aria-label="Call transcript">
            {lines.map(l => <p key={l.id} className={l.who}>{l.who === 'you' ? 'You' : l.who === 'grandma' ? 'Grandma' : ''}{l.who !== 'note' && <b> · </b>}{l.text}</p>)}
          </div>
          {world.active && <div className="progress" aria-hidden="true"><i style={{ width: `${world.active.elapsed / world.active.duration * 100}%` }} /></div>}
          <div className="mic-row">
          {VOICE_AVAILABLE && <button type="button" className={`mic ${voice.status} ${voice.speaking ? 'speaking' : ''} ${voice.microphoneEnabled ? 'listening' : 'muted'}`} aria-label={voiceLabel} title={voiceLabel} disabled={voice.status === 'microphone' || voice.status === 'connecting' || !running} onClick={onMic}><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg></button>}
          <button type="button" className="voice-toggle" aria-pressed={!spokenReplies} onClick={() => { if (spokenReplies) stopSpeaking(); setSpokenReplies(!spokenReplies); }}>{spokenReplies ? 'Mute Grandma' : 'Hear Grandma'}</button>
          </div>
          <p className="connection-note" role="status">{voice.status === 'connected' ? (voice.microphoneEnabled ? 'Natural voice · speak or type' : 'Natural voice · type to Grandma') : 'Offline dialogue · basic browser voice'}</p>
          {voice.status === 'error' && <p className="connection-note" role="status">{voice.error || 'Voice couldn’t connect. Keep typing, or tap the mic to retry.'}</p>}
          {voice.status === 'connected' && voice.error && <p className="connection-note" role="status">{voice.error}</p>}
          <form className="composer" onSubmit={send}>
            <input aria-label="Tell Grandma what to do" placeholder="Tell Grandma…" value={draft} onChange={e => setDraft(e.target.value)} autoComplete="off" disabled={!callLive} enterKeyHint="send" />
            <button type="submit" className="primary composer-send" disabled={!callLive || !draft.trim()} aria-label="Send instruction">Send ↗</button>
          </form>
        </div>
      </div>
    </div>
  </>;
}
