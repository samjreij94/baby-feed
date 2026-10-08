import { useEffect } from 'react';

export function Toast({ text, onDone }: { text: string | null; onDone: () => void }) {
  useEffect(() => {
    if (!text) return;
    const id = window.setTimeout(onDone, 2600);
    return () => window.clearTimeout(id);
  }, [text, onDone]);
  return <div className={`toast${text ? ' show' : ''}`} role="status" aria-live="polite">{text}</div>;
}
