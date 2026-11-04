import { useEffect, useRef, useState, type FormEvent } from 'react';
import { gameCommands, gameController, simulation } from './game/session';
import Scene from './view/Scene';
import StartScreen from './view/StartScreen';
import Intro, { GREETING, RULES } from './view/Intro';
import Outro, { OUTRO_LINES } from './view/Outro';
import { speak, stopSpeaking } from './voice/grandma-voice';
import { EXAMPLES, parseInstruction } from './voice/text-commands';
import { useVoice } from './voice/useVoice';
import { useIntroMusic } from './view/intro-music';
import { useLeakSound } from './view/leak-sound';
import { useMaydaySiren } from './view/mayday-sound';
import { TUNING } from './game/config';
import { PLAYER_TURN_SECONDS, useTurns } from './view/useTurns';

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
  const resumeVoice = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  // Yao's realtime voice agent. Connects when Grandma's greeting begins; typed text stays as a fallback.
  const voice = useVoice();
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
  useEffect(() => gameController.subscribe(event => {
    if (event.type === 'state_changed') setWorld(simulation.readState());
    if (event.type === 'action_result' && event.result.status !== 'cancelled') say('grandma', event.result.message);
    if (event.type === 'misunderstanding') say('note', `Grandma went for the ${event.selectedTarget.replaceAll('_', ' ')} instead.`);
    if (event.type === 'terminal') say('note', event.message);
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
  // Turns: the player speaks or types inside a short window, then Grandma answers and acts.
  const speechAtTurnStart = useRef(0);
  const turns = useTurns({
    enabled: running && intro === 'done' && voice.status === 'connected',
    busy: !!world.active || world.queue.length > 0,
    speaking: voice.speaking,
    onPlayerTurnEnd: () => { if (voice.status === 'connected' && voice.speechEnded > speechAtTurnStart.current) voice.respond(); },
  });
  const playersTurn = running && intro === 'done' && (voice.status !== 'connected' || turns.turn === 'player');
  const currentTurn = voice.status === 'connected' ? turns.turn : world.active || world.queue.length ? 'grandma' : 'player';
  useEffect(() => { if (turns.turn === 'player') speechAtTurnStart.current = voice.speechEnded; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [turns.turn]);
  // When the caller stops talking, the server commits their speech; that ends the turn with no button needed.
  useEffect(() => { if (voice.speechEnded && playersTurn) turns.endPlayerTurn(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [voice.speechEnded]);
  // The mic stays open during a live call so you can barge in; the server never answers on its own.
  const callLive = running && intro === 'done';
  useEffect(() => { setMute(!callLive); }, [callLive, setMute]);
  // Her speaker is silent on your turn, so she can never talk over you; it reopens for her turn and the outro.
  useEffect(() => { voice.setOutputMuted(callLive && turns.turn === 'player'); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [callLive, turns.turn]);
  // Barge-in: when you start talking during Grandma's turn, she stops and the turn is yours.
  useEffect(() => {
    if (!voice.speechStarted || !callLive || (turns.turn !== 'grandma' && !voice.speaking)) return;
    voice.hush();
    gameCommands.interrupt();
    turns.startPlayerTurn();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voice.speechStarted]);
  // Win and loss each have one fixed line from Grandma, spoken live when connected, synthesized otherwise.
  useEffect(() => {
    if (!terminal) return;
    const text = OUTRO_LINES[world.stage as 'won' | 'lost'];
    stopSpeaking();
    if (voice.status === 'connected') voice.sayLine(text); else void speak(text);
    say('grandma', text);
    const close = window.setTimeout(voice.disconnect, 7000);
    return () => clearTimeout(close);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminal]);
  useEffect(() => {
    if (world.stage !== 'paused') return;
    resumeVoice.current = voice.status === 'connected';
    voice.disconnect();
    // The pause transition owns teardown; status changes must not erase the resume choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world.stage, voice.disconnect]);
  const voiceLabel = voice.status === 'connected' ? (playersTurn ? 'Listening… tap when you are done' : 'Tap to respond to Grandma') : voice.status === 'microphone' ? 'Allow the microphone…' : voice.status === 'connecting' ? 'Connecting voice…' : voice.status === 'error' ? 'Voice unavailable, tap to retry' : 'Tap to turn on voice';
  // Tapping the mic: connect voice if needed, otherwise take your turn (mic opens) or finish it.
  const onMic = () => {
    if (voice.status !== 'connected') { void voice.connect(); return; }
    if (playersTurn) turns.endPlayerTurn();
    else { voice.hush(); gameCommands.interrupt(); turns.startPlayerTurn(); }
  };
  // Mirror the live conversation into the transcript; fall back to synthesized speech if voice is unavailable.
  useEffect(() => { if (voice.grandmaSaid) setLines(old => old.at(-1)?.who === 'grandma' && old.at(-1)?.text === voice.grandmaSaid ? old : [...old, line('grandma', voice.grandmaSaid)].slice(-40)); }, [voice.grandmaSaid]);
  useEffect(() => { if (voice.youSaid) say('you', voice.youSaid); }, [voice.youSaid]);
  const elapsed = `${Math.floor(world.elapsed / 60).toString().padStart(2, '0')}:${Math.floor(world.elapsed % 60).toString().padStart(2, '0')}`;

  // PLACEHOLDER for Yao's voice agent: typed text stands in for speech, then flows through the same command session.
  const send = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !playersTurn) return;
    setDraft('');
    say('you', text);
    if (/^(help|\?)$/i.test(text)) { say('note', `Try: ${EXAMPLES.join(' · ')}`); return; }
    const parsed = parseInstruction(text);
    if (!parsed.ok) { say('note', parsed.hint); return; }
    if (voice.status === 'connected') { voice.hush(); turns.endPlayerTurn(); }
    const turn = gameCommands.beginTurn();
    void gameCommands.submit(turn.token, parsed.steps).then(outcome => {
      if (outcome.status === 'rejected') say('note', outcome.code === 'NOT_RUNNING' ? 'Answer the call first.' : `Could not send that (${outcome.code}).`);
    });
  };
  const startCall = () => {
    gameController.start();
    if (document.hidden) gameController.pause();
  };
  const restart = () => {
    voice.disconnect(); gameCommands.interrupt(); gameController.reset(); startCall();
    setLines([]); setDraft(''); setHelpOpen(false);
    if (VOICE_AVAILABLE) void voice.connect().then(() => voice.greet());
  };
  const resume = () => {
    setHelpOpen(false); gameController.resume();
    if (resumeVoice.current) { resumeVoice.current = false; void voice.connect(); }
  };

  return <>
    {/* Connect inside the click so the mic prompt and audio unlock happen in the user gesture. */}
    {!started && <StartScreen voiceAvailable={VOICE_AVAILABLE} onStart={() => { setStarted(true); setIntro('playing'); if (VOICE_AVAILABLE) void voice.connect(); }} />}
    <div className="stage" inert={!started}>
      <div className={`phone ${mayday ? 'mayday' : ''}`} data-testid="phone">
        {/* Grandma's hands are not steady: CSS shake layers scale with what she is doing. */}
        <div className={`camera-view ${world.phone.placement === 'hand' && running ? 'handheld' : ''} ${world.active?.to ? 'walking' : ''} stress-${gameController.getObservation().stressBand}`} data-testid="camera-view"><Scene world={world} /></div>

        <div className="call-time"><span className={`dot ${running ? 'live' : ''}`} />{elapsed}</div>
        {intro === 'done' && running && <button type="button" className="call-help" onClick={() => { setHelpOpen(true); gameController.pause(); }}>How to play</button>}
        {intro === 'done' && running && <div className={`turn-banner ${currentTurn}`} role="status">
          <span className="turn-label">{currentTurn === 'player' ? 'Your turn · tell Grandma what to do' : voice.speaking ? 'Grandma is talking…' : world.active ? 'Grandma is on it…' : 'Grandma’s turn'}</span>
          {voice.status === 'connected' && turns.turn === 'player' && <><span className="turn-count">{Math.ceil(turns.remaining)}</span><div className="turn-bar"><i style={{ width: `${turns.remaining / PLAYER_TURN_SECONDS * 100}%` }} /></div></>}
        </div>}
        {intro === 'playing' && <Intro voice={voice} onGreeting={live => { if (!live) say('grandma', GREETING); }} onDone={startCall} onFinished={() => setIntro('done')} />}
        {world.stage === 'paused' && <div className="call-overlay" role="dialog" aria-modal="true" aria-labelledby="pause-title"><div className="call-card compact"><span className="eyebrow">TAKE A BREATH</span><h2 id="pause-title">{helpOpen ? 'How to save Grandma' : 'Call paused.'}</h2><p>The water and Grandma’s actions are paused.</p>{helpOpen && <ul className="help-rules">{RULES.map(rule => <li key={rule}>{rule}</li>)}</ul>}<button autoFocus className="primary" onClick={resume}>Resume call ↗</button></div></div>}
        {terminal && <Outro outcome={world.stage as 'won' | 'lost'} onRestart={restart} />}

        <div className="call-bottom" inert={!running || intro !== 'done'}>
          <div className="transcript" ref={transcript} role="log" aria-live="polite" aria-label="Call transcript">
            {lines.map(l => <p key={l.id} className={l.who}>{l.who === 'you' ? 'You' : l.who === 'grandma' ? 'Grandma' : ''}{l.who !== 'note' && <b> · </b>}{l.text}</p>)}
          </div>
          {world.active && <div className="progress" aria-hidden="true"><i style={{ width: `${world.active.elapsed / world.active.duration * 100}%` }} /></div>}
          {VOICE_AVAILABLE && <div className="mic-row">
          <button type="button" className={`mic ${voice.status} ${voice.speaking ? 'speaking' : ''} ${playersTurn && voice.status === 'connected' ? 'listening' : 'muted'}`} aria-label={voiceLabel} title={voiceLabel} disabled={voice.status === 'microphone' || voice.status === 'connecting' || (voice.status === 'connected' && !running)} onClick={onMic}><svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" /></svg></button>
          </div>}
          {voice.status === 'error' && <p className="connection-note" role="status">Voice couldn’t connect. Keep typing, or tap the mic to retry.</p>}
          <form className="composer" onSubmit={send}>
            <input aria-label="Tell Grandma what to do" placeholder={!running ? 'Connecting…' : playersTurn ? 'Tell Grandma…' : 'Grandma’s turn…'} value={draft} onChange={e => setDraft(e.target.value)} autoComplete="off" disabled={!playersTurn} enterKeyHint="send" />
            <button type="submit" className="primary composer-send" disabled={!playersTurn || !draft.trim()} aria-label="Send instruction">Send ↗</button>
          </form>
        </div>
      </div>
    </div>
  </>;
}
