import ringtoneUrl from '../../public/audio/iphone-ringtone.mp3';

/** The project's original incoming-call recording, restored at Jeffrey's request. */
export function playIncomingCallRingtone() {
  const audio = new Audio(ringtoneUrl);
  audio.loop = true;
  audio.volume = 0.65;
  audio.preload = 'auto';
  let stopped = false;
  const play = () => {
    if (!stopped && !document.hidden) void audio.play().catch(() => {});
  };
  const visibility = () => { if (document.hidden) audio.pause(); else play(); };
  // Retry within a gesture if the browser initially blocks playback.
  window.addEventListener('pointerdown', play);
  window.addEventListener('keydown', play);
  document.addEventListener('visibilitychange', visibility);
  play();
  return { stop() {
    if (stopped) return;
    stopped = true;
    window.removeEventListener('pointerdown', play);
    window.removeEventListener('keydown', play);
    document.removeEventListener('visibilitychange', visibility);
    audio.pause();
    audio.currentTime = 0;
    audio.removeAttribute('src');
    audio.load();
  } };
}
