import { useEffect } from 'react';
import { playDemoSound } from './demo-audio';

export type MusicMode = 'title' | 'intro' | 'off';

/** Original mallet loop. It unlocks after a gesture and stops when the call starts. */
export function useIntroMusic(mode: MusicMode) {
  useEffect(() => {
    if (mode === 'off') return;
    const sound = playDemoSound('title', mode === 'title' ? 0.5 : 0.22);
    return sound.stop;
  }, [mode]);
}
