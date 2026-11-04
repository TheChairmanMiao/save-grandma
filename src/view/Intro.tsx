import { useEffect, useRef, useState } from 'react';
import grandmaImage from '../../public/images/grandma-profile.png';
import { speak } from '../voice/grandma-voice';
import { GRANDMA_GREETING } from '../voice/persona';
import type { VoiceStatus } from '../voice/useVoice';
import { playDemoSound } from './demo-audio';

/** Scripted fallback used only when the realtime voice agent is unavailable. */
export const GREETING = GRANDMA_GREETING;
export const RULES = [
  'Grandma only does what you tell her.',
  'You have five minutes before the room floods.',
  'The wrench is in one of the three toolboxes on the table.',
  'Say “front camera” to see Grandma, “rear camera” for the room.',
  'Be specific: “open the red toolbox”, “turn the pipe counterclockwise”.',
];
const FALLBACK_GREETING_SECONDS = 6;
const MAX_CONNECT_WAIT_SECONDS = 12;
const MAX_GREETING_SECONDS = 7;
const RULES_SECONDS = 4;
const FADE_SECONDS = 0.7;

type Phase = 'ringing' | 'greeting' | 'rules' | 'fade-out' | 'fade-in';
export type IntroVoice = { status: VoiceStatus; speaking: boolean; grandmaSaid: string; greet: () => void; hush?: () => void };

export function RulesList({ className }: { className: string }) {
  return <div className={className}><h3>How to save Grandma</h3><ul>{RULES.map(rule => <li key={rule}>{rule}</li>)}</ul></div>;
}

/**
 * Cinematic opening: Granny's incoming call rings until the player answers, then the screen
 * turns on and Grandma greets the caller live. The rules follow once she finishes, then a fade
 * into the running game. If voice never connects, the scripted greeting is spoken instead.
 */
export default function Intro({ voice, onGreeting, onDone, onFinished }: { voice: IntroVoice; onGreeting: (live: boolean) => void; onDone: () => void; onFinished: () => void }) {
  const [phase, setPhase] = useState<Phase>('ringing');
  const [answered, setAnswered] = useState(false);
  const [gaveUpWaiting, setGaveUpWaiting] = useState(false);
  const live = useRef(false);
  const hasSpoken = useRef(false);

  // Original two-tone ringtone; no third-party recording is loaded.
  useEffect(() => {
    if (answered) return;
    const ring = playDemoSound('ringtone', 0.8);
    return ring.stop;
  }, [answered]);
  useEffect(() => {
    if (!answered) return;
    const giveUp = window.setTimeout(() => setGaveUpWaiting(true), MAX_CONNECT_WAIT_SECONDS * 1000);
    return () => clearTimeout(giveUp);
  }, [answered]);

  // Screen turns on once the call is answered and the voice connection has settled one way or the other.
  useEffect(() => {
    if (phase !== 'ringing' || !answered) return;
    const settled = voice.status === 'connected' || voice.status === 'error' || voice.status === 'idle';
    if (!settled && !gaveUpWaiting) return;
    live.current = voice.status === 'connected';
    setPhase('greeting');
    onGreeting(live.current);
    if (live.current) voice.greet(); else void speak(GREETING);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, answered, gaveUpWaiting, voice.status]);

  // The greeting lasts as long as Grandma talks (live) or a fixed beat (fallback).
  useEffect(() => {
    if (phase !== 'greeting') return;
    if (!live.current) { const t = window.setTimeout(() => setPhase('rules'), FALLBACK_GREETING_SECONDS * 1000); return () => clearTimeout(t); }
    if (voice.speaking) hasSpoken.current = true;
    const finished = hasSpoken.current && !voice.speaking;
    // Keep the opening tight: if Grandma is still going at the cap, cut her off and move on.
    const t = window.setTimeout(() => { if (!finished) voice.hush?.(); setPhase('rules'); }, (finished ? 0.8 : MAX_GREETING_SECONDS) * 1000);
    return () => clearTimeout(t);
  }, [phase, voice.speaking]);

  useEffect(() => {
    if (phase === 'rules') { const t = window.setTimeout(() => setPhase('fade-out'), RULES_SECONDS * 1000); return () => clearTimeout(t); }
    if (phase === 'fade-out') { const t = window.setTimeout(() => { setPhase('fade-in'); onDone(); }, FADE_SECONDS * 1000); return () => clearTimeout(t); }
    if (phase === 'fade-in') { const t = window.setTimeout(onFinished, (FADE_SECONDS + 0.2) * 1000); return () => clearTimeout(t); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (phase === 'ringing') return <div className="intro-black incoming-call" role="dialog" aria-label="Incoming call from Granny">
    <div className="caller-avatar" aria-hidden="true"><img src={grandmaImage} alt="" width={1254} height={1254} /></div>
    <h2>Granny</h2>
    <p>{answered ? 'Connecting…' : 'incoming call'}</p>
    <button type="button" className="answer-button" onClick={() => setAnswered(true)} disabled={answered} aria-label="Answer the call">
      <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1L6.6 10.8z" /></svg>
      <span>Answer</span>
    </button>
  </div>;
  if (phase === 'fade-out') return <div className="intro-black fade-out" />;
  if (phase === 'fade-in') return <div className="intro-black fade-in" />;
  // Grandma's words land in the transcript, so no speech bubble is drawn over her face.
  return <div className="intro-layer screen-on">
    {phase === 'rules' && <div className="rules-backdrop"><RulesList className="rules rules-center" /></div>}
  </div>;
}
