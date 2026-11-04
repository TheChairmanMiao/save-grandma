import { useEffect } from 'react';
import { playDemoSound } from './demo-audio';

/** A quiet original two-note warning during the final minute. */
export function useMaydaySiren(active: boolean, cut = false) {
  useEffect(() => {
    if (!active || cut) return;
    const sound = playDemoSound('alarm', 0.22);
    return sound.stop;
  }, [active, cut]);
}
