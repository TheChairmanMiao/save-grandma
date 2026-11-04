import { useEffect } from 'react';
import { playDemoSound } from './demo-audio';

/** Generated water ambience, louder after wrong turns and silent on pause or game over. */
export function useLeakSound(active: boolean, intensity: number, cut = false) {
  const level = Math.min(0.85, 0.35 + (Math.max(1, intensity) - 1) * 0.18);
  useEffect(() => {
    if (!active || cut) return;
    const sound = playDemoSound('water', level);
    return sound.stop;
  }, [active, cut, level]);
}
