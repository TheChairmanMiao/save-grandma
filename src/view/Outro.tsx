import grandmaImage from '../../public/images/grandma-profile.png';
import { GRANDMA_OUTRO_LINES } from '../voice/persona';

/** End-of-call screens. Loss blacks out instantly; a win fades to black. Grandma's line is spoken by the voice layer. */
export const OUTRO_LINES = GRANDMA_OUTRO_LINES;

export default function Outro({ outcome, onRestart }: { outcome: 'won' | 'lost'; onRestart: () => void }) {
  return <div className={`intro-black outro ${outcome}`} role="dialog" aria-modal="true" aria-labelledby="outro-title">
    <div className="caller-avatar" aria-hidden="true"><img src={grandmaImage} alt="" width={1254} height={1254} /></div>
    <h2 id="outro-title">{OUTRO_LINES[outcome]}</h2>
    <button type="button" className="start-button" autoFocus onClick={onRestart}>{outcome === 'won' ? 'Play again' : 'Try again'}</button>
  </div>;
}
