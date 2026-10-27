import { useEffect, useState } from 'react';
import { BottomSheet } from './BottomSheet';
import { TimeField } from './TimeField';
import { fmtClock } from '../ui/format';

/** "Started earlier?" — change when a running feed began (forgot to start the timer). Can't be in the future. */
export function StartTimeSheet({ open, startedAt, onClose, onSave }: { open: boolean; startedAt: number; onClose: () => void; onSave: (t: number) => Promise<void> | void }) {
  const [t, setT] = useState(startedAt);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setT(startedAt); }, [open, startedAt]);
  const now = Date.now();
  const ago = Math.max(0, now - t);
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title="Started earlier?"
      footer={
        <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy || t === startedAt}
          onClick={async () => { setBusy(true); try { await onSave(Math.min(t, Date.now())); onClose(); } finally { setBusy(false); } }}>
          Save start time
        </button>
      }
    >
      <TimeField caption="Started at" value={t} max={now} onChange={(v) => setT(Math.min(v, Date.now()))} />
      <div className="dim small" role="status">Elapsed would be {fmtClock(ago)} so far. Can’t be in the future; the 15-minute check-in follows this time.</div>
    </BottomSheet>
  );
}
