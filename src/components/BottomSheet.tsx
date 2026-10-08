import { useEffect, useId, type ReactNode } from 'react';

/** Modal bottom sheet: body scrolls; optional pinned `footer` sits above the home indicator. */
export function BottomSheet({ open, onClose, title, children, footer, headerExtra }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; headerExtra?: ReactNode }) {
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = prev; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="sheet-backdrop" onClick={onClose} />
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={id}>
        <div className="grabber" />
        <div className="sheet-head">
          <h2 id={id}>{title}</h2>
          {headerExtra}
          <button type="button" className="btn btn-quiet" onClick={onClose}>Cancel</button>
        </div>
        <div className="sheet-body" data-testid="sheet-body">{children}</div>
        {footer && <div className="sheet-foot">{footer}</div>}
      </div>
    </>
  );
}
