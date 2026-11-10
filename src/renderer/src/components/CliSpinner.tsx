import { useEffect, useState, type CSSProperties } from 'react';

/** The glyph cycle of the Claude Code CLI's spinner (✻ Working…), forward then back. */
export const SPINNER_FRAMES = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The CLI's animated star. Static (✻) when the OS asks for reduced motion. */
export function CliSpinner({ color = 'var(--cth-coral)', style }: { color?: string; style?: CSSProperties }) {
  const [frame, setFrame] = useState(prefersReducedMotion() ? 4 : 0);
  useEffect(() => {
    if (prefersReducedMotion()) return;
    const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block', width: 14, textAlign: 'center', fontSize: '1.15em',
      color, fontFamily: 'var(--cth-font-mono)', lineHeight: 1,
      ...style
    }}>
      {SPINNER_FRAMES[frame]}
    </span>
  );
}
