import { useEffect, useId, useState } from 'react';
import { IconMinus, IconPlus } from './Icons';

interface Props {
  /** Visible caption. Rendered as a plain <div> (never a <label>) so tapping it can't activate a button. */
  caption: string;
  value: number;
  step: number;
  min?: number;
  max?: number;
  /** Unit suffix shown after the number, e.g. "oz". */
  suffix?: string;
  /** Display transform (e.g. oz → ml) and its inverse for typed input. */
  toDisplay?: (v: number) => number;
  fromDisplay?: (v: number) => number;
  format?: (display: number) => string;
  onChange: (v: number) => void;
}

const snap = (v: number, step: number) => Math.round(v / step) * step;
const defaultFormat = (d: number) => (Number.isInteger(d) ? String(d) : d.toFixed(2).replace(/0$/, ''));

/**
 * Big − / + stepper. Buttons and input are ≥ 56px. The caption is a sibling <div> referenced by
 * aria-labelledby — no <label> wraps or points at any control (the gym-app label-tap bug).
 */
export function Stepper({ caption, value, step, min = 0, max = 99, suffix, toDisplay = (v) => v, fromDisplay = (v) => v, format = defaultFormat, onChange }: Props) {
  const id = useId();
  const shown = format(toDisplay(value));
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const clamp = (v: number) => Math.min(max, Math.max(min, Number(snap(v, step).toFixed(4))));
  const commit = () => {
    const n = parseFloat(draft.replace(',', '.'));
    if (Number.isFinite(n)) onChange(clamp(fromDisplay(n)));
    else setDraft(shown);
  };
  return (
    <div className="stepper-field">
      <div className="caption" id={`${id}-cap`} data-testid="stepper-caption">{caption}</div>
      <div className="stepper" role="group" aria-labelledby={`${id}-cap`}>
        <button type="button" className="step-btn" aria-label={`Decrease ${caption}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
          <IconMinus />
        </button>
        <div className="step-value">
          <input
            className="num"
            style={{ width: `${Math.max(1, draft.length) + 0.6}ch` }}
            inputMode="decimal"
            enterKeyHint="done"
            aria-labelledby={`${id}-cap`}
            aria-describedby={suffix ? `${id}-suf` : undefined}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          />
          {suffix && <span className="suffix" id={`${id}-suf`}>{suffix}</span>}
        </div>
        <button type="button" className="step-btn" aria-label={`Increase ${caption}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
          <IconPlus />
        </button>
      </div>
    </div>
  );
}
