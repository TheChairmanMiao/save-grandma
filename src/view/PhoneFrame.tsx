import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Fit one fixed mobile layout to a desktop window without rearranging the game. */
export default function PhoneFrame({ children }: { children: ReactNode }) {
  const stage = useRef<HTMLDivElement>(null);
  const device = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const outer = stage.current;
    const frame = device.current;
    if (!outer || !frame) return;
    const fit = () => {
      const scale = Math.min(1.35, (outer.clientWidth - 48) / frame.offsetWidth, (outer.clientHeight - 48) / frame.offsetHeight);
      frame.style.setProperty('--phone-scale', String(Math.max(0.1, scale)));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(outer);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  return <div ref={stage} className="stage"><div ref={device} className="phone-device">{children}</div></div>;
}
