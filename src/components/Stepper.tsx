import { useEffect, useId, useRef, useState } from 'react';
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
 * Why the shield: mobile browsers "touch-adjust" a finger tap that lands on non-interactive space to the nearest
 * clickable element. The 10px gap beside − / + was plain grid gap, so a tap there snapped to the button and changed
 * the value. The shield is an inert layer BEHIND the row and caption (a sibling, not an ancestor of the buttons) with
 * a native no-op click listener, so the browser treats it as the tap target and the tap does nothing.
 * React's delegated handlers don't count for touch adjustment, hence addEventListener.
 */
function useInertTarget<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const noop = () => {};
    el.addEventListener('click', noop);
    return () => el.removeEventListener('click', noop);
  }, []);
  return ref;
}

/** Explicit, inert grid cell between a button and the value box (replaces the CSS grid gap). */
function StepGap() {
  const ref = useInertTarget<HTMLSpanElement>();
  return <span className="step-gap" ref={ref} aria-hidden data-testid="stepper-gap" />;
}

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
  const shield = useInertTarget<HTMLDivElement>();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="stepper-field">
      <div className="tap-shield" ref={shield} aria-hidden data-testid="stepper-shield" />
      <div className="caption" id={`${id}-cap`} data-testid="stepper-caption">{caption}</div>
      <div className="stepper" role="group" aria-labelledby={`${id}-cap`}>
        <button type="button" className="step-btn" aria-label={`Decrease ${caption}`} disabled={value <= min} onClick={() => onChange(clamp(value - step))}>
          <IconMinus />
        </button>
        <StepGap />
        {/* Tapping anywhere in the value box types into it (never changes the value by itself). */}
        <div className="step-value" onClick={(e) => { if (e.target !== input.current) input.current?.focus(); }}>
          <input
            ref={input}
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
        <StepGap />
        <button type="button" className="step-btn" aria-label={`Increase ${caption}`} disabled={value >= max} onClick={() => onChange(clamp(value + step))}>
          <IconPlus />
        </button>
      </div>
    </div>
  );
}
