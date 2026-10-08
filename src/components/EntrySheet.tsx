import { useEffect, useState } from 'react';
import { fmtOzNum, OZ_TO_ML } from '../ui/format';
import type { EntryDraft, Milk, Side, Units } from '../ui/types';
import { BottomSheet } from './BottomSheet';
import { Segmented } from './Segmented';
import { Stepper } from './Stepper';
import { TimeField } from './TimeField';

export type SheetMode = 'bottle' | 'edit' | 'add';

const QUICK_OZ = [2, 3, 4, 5];
const MILK_OPTS = [{ value: 'breast', label: 'Breast milk' }, { value: 'formula', label: 'Formula' }] as const;
const SIDE_OPTS = [{ value: 'L', label: 'Left' }, { value: 'R', label: 'Right' }] as const;
const KIND_OPTS = [{ value: 'breast', label: 'Breastfeed' }, { value: 'bottle', label: 'Bottle' }] as const;

export const newBottleDraft = (lastOz = 3): Extract<EntryDraft, { kind: 'bottle' }> => ({ kind: 'bottle', at: Date.now(), amountOz: lastOz, milk: 'breast' });
export const newBreastDraft = (side: Side = 'L'): Extract<EntryDraft, { kind: 'breast' }> => ({ kind: 'breast', startedAt: Date.now() - 20 * 60_000, first: side, minutes: { L: side === 'L' ? 10 : 0, R: side === 'R' ? 10 : 0 } });

/** Bottle sheet (new bottle), edit sheet (existing entry) and "add past feed" sheet. */
export function EntrySheet({ open, mode, initial, units, onSave, onDelete, onClose }: {
  open: boolean; mode: SheetMode; initial: EntryDraft | null; units: Units;
  onSave: (d: EntryDraft, original: EntryDraft | null) => Promise<void>; onDelete?: () => void; onClose: () => void;
}) {
  const [d, setD] = useState<EntryDraft | null>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setD(initial); setErr(null); } }, [open, initial]);
  if (!open || !d) return null;

  const title = mode === 'bottle' ? 'Bottle' : mode === 'add' ? 'Add a past feed' : d.kind === 'bottle' ? 'Edit bottle' : 'Edit breastfeed';
  const ml = units === 'ml';
  const save = async () => {
    setBusy(true); setErr(null);
    try { await onSave(d, initial); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const total = d.kind === 'breast' ? d.minutes.L + d.minutes.R : 0;
  const canSave = d.kind === 'bottle' ? d.amountOz > 0 : total > 0;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      footer={<button type="button" className="btn btn-primary btn-lg" disabled={!canSave || busy} onClick={save}>{mode === 'edit' ? 'Save changes' : 'Save'}</button>}
    >
      {mode === 'add' && (
        <Segmented label="Feed type" value={d.kind} options={KIND_OPTS}
          onChange={(k) => setD(k === 'bottle' ? { ...newBottleDraft(), at: d.kind === 'breast' ? d.startedAt : d.at } : { ...newBreastDraft(), startedAt: d.kind === 'bottle' ? d.at : d.startedAt })} />
      )}
      {d.kind === 'bottle' ? (
        <div className="stack-lg">
          <Stepper
            caption="Amount"
            value={d.amountOz}
            step={0.25}
            min={0.25}
            max={12}
            suffix={units}
            toDisplay={ml ? (oz) => Math.round(oz * OZ_TO_ML) : undefined}
            fromDisplay={ml ? (v) => v / OZ_TO_ML : undefined}
            format={ml ? (v) => String(v) : undefined}
            onChange={(amountOz) => setD({ ...d, amountOz })}
          />
          <div className="quick" role="group" aria-label="Quick amounts">
            {QUICK_OZ.map((oz) => (
              <button key={oz} type="button" className="btn btn-sm" aria-pressed={d.amountOz === oz} onClick={() => setD({ ...d, amountOz: oz })}>
                {ml ? `${Math.round((oz * OZ_TO_ML) / 5) * 5} ml` : `${fmtOzNum(oz)} oz`}
              </button>
            ))}
          </div>
          <div className="field">
            <div className="caption">Milk</div>
            <Segmented label="Milk" value={d.milk} options={MILK_OPTS} onChange={(milk: Milk) => setD({ ...d, milk })} size="lg" />
          </div>
          <TimeField caption="Time" value={d.at} max={Date.now() + 60_000} onChange={(at) => setD({ ...d, at })} />
        </div>
      ) : (
        <div className="stack-lg">
          <TimeField caption="Started" value={d.startedAt} max={Date.now()} onChange={(startedAt) => setD({ ...d, startedAt })} />
          <div className="field">
            <div className="caption">Started on</div>
            <Segmented label="Started on" value={d.first} options={SIDE_OPTS} onChange={(first) => setD({ ...d, first })} size="lg" />
          </div>
          <Stepper caption="Left side" value={d.minutes.L} step={1} min={0} max={120} suffix="min" onChange={(L) => setD({ ...d, minutes: { ...d.minutes, L } })} />
          <Stepper caption="Right side" value={d.minutes.R} step={1} min={0} max={120} suffix="min" onChange={(R) => setD({ ...d, minutes: { ...d.minutes, R } })} />
          <div className="dim small">Total {total} min</div>
        </div>
      )}
      {err && <div className="error" role="alert">{err}</div>}
      {mode === 'edit' && onDelete && (
        <button type="button" className="btn btn-danger btn-block" onClick={onDelete}>Delete this feed</button>
      )}
    </BottomSheet>
  );
}
