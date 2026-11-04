import titleImage from '../../public/images/save-grandma-title.png';

/** Title screen shown before the call interface. Purely presentational; it never touches the simulation. */
export default function StartScreen({ onStart, voiceAvailable }: { onStart: () => void; voiceAvailable: boolean }) {
  return <div className="start-screen" role="dialog" aria-modal="true" aria-labelledby="start-title">
    <div className="bubbles" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ left: `${(i * 83) % 100}%`, animationDelay: `${(i * 1.7) % 9}s`, width: `${28 + (i * 37) % 70}px` }} />)}</div>
    <div className="start-card">
      <h1 id="start-title" className="start-title"><img src={titleImage} alt="Save Grandma" width={1536} height={1024} /></h1>
      <button className="start-button" aria-label="Start the game" autoFocus onClick={onStart}>Start</button>
      <p className="demo-caption">One call. Five minutes. Save Grandma.<br /><span>{voiceAvailable ? 'Speak or type your instructions.' : 'Type your instructions. No microphone needed.'}</span></p>
    </div>
  </div>;
}
