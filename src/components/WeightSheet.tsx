import { useEffect, useState } from 'react';
import { gramsToKg, gramsToLbOz, kgToGrams, lbOzToGrams, MAX_GRAMS, MIN_GRAMS } from '../ui/adapter';
import type { WeightDraft, WeightUnit } from '../ui/types';
import { BottomSheet } from './BottomSheet';
import { Segmented } from './Segmented';
import { Stepper } from './Stepper';
import { TimeField } from './TimeField';

const UNIT_OPTS = [{ value: 'lb', label: 'lb / oz' }, { value: 'kg', label: 'kg' }] as const;

/** Newest weight (or a typical newborn 7 lb) as the starting point, "now" as the time. */
export const newWeightDraft = (lastGrams?: number): WeightDraft => ({ at: Date.now(), grams: lastGrams ?? lbOzToGrams(7, 0) });

/** Add / edit a weight. Entry in lb + oz (0.1 oz steps) or kg (0.01 steps); stored as grams. */
export function WeightSheet({ open, initial, unit, onUnit, onSave, onDelete, onClose }: {
  open: boolean; initial: WeightDraft | null; unit: WeightUnit; onUnit: (u: WeightUnit) => void;
  onSave: (d: WeightDraft) => Promise<void>; onDelete?: () => void; onClose: () => void;
}) {
  const [d, setD] = useState<WeightDraft | null>(initial);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setD(initial); setErr(null); } }, [open, initial]);
  if (!open || !d) return null;
  const editing = !!d.id;
  const { lb, oz } = gramsToLbOz(d.grams);
  const valid = d.grams >= MIN_GRAMS && d.grams <= MAX_GRAMS;
  const save = async () => {
    setBusy(true); setErr(null);
    try { await onSave(d); onClose(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={editing ? 'Edit weight' : 'Add weight'}
      footer={<button type="button" className="btn btn-primary btn-lg" disabled={!valid || busy} onClick={save}>{editing ? 'Save changes' : 'Save'}</button>}
    >
      <div className="stack-lg">
        <div className="field">
          <div className="caption">Units</div>
          <Segmented label="Weight units" value={unit} options={UNIT_OPTS} onChange={onUnit} size="lg" />
        </div>
        {unit === 'lb' ? (
          <>
            <Stepper caption="Pounds" value={lb} step={1} min={0} max={66} suffix="lb" onChange={(v) => setD({ ...d, grams: lbOzToGrams(v, oz) })} />
            <Stepper caption="Ounces" value={oz} step={0.1} min={0} max={15.9} suffix="oz" format={(v) => v.toFixed(1)} onChange={(v) => setD({ ...d, grams: lbOzToGrams(lb, v) })} />
          </>
        ) : (
          <Stepper caption="Weight" value={Number(gramsToKg(d.grams).toFixed(2))} step={0.01} min={0.1} max={30} suffix="kg" format={(v) => v.toFixed(2)} onChange={(v) => setD({ ...d, grams: kgToGrams(v) })} />
        )}
        <TimeField caption="Weighed on" value={d.at} max={Date.now() + 60_000} onChange={(at) => setD({ ...d, at })} />
      </div>
      {err && <div className="error" role="alert">{err}</div>}
      {editing && onDelete && (
        <button type="button" className="btn btn-danger btn-block" onClick={onDelete}>Delete this weight</button>
      )}
    </BottomSheet>
  );
}
