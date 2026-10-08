import { useId } from 'react';
import { fromLocalInput, toLocalInput } from '../ui/format';

/** Native date+time picker (iOS wheel) with a "Now" shortcut. Caption is a <div>, not a <label>. */
export function TimeField({ caption, value, onChange, max }: { caption: string; value: number; onChange: (t: number) => void; max?: number }) {
  const id = useId();
  return (
    <div className="field">
      <div className="caption" id={id}>{caption}</div>
      <div className="row">
        <input
          type="datetime-local"
          className="input time-input"
          aria-labelledby={id}
          value={toLocalInput(value)}
          max={max ? toLocalInput(max) : undefined}
          onChange={(e) => { const t = fromLocalInput(e.target.value); if (t !== null) onChange(t); }}
        />
        <button type="button" className="btn" onClick={() => onChange(Date.now())}>Now</button>
      </div>
    </div>
  );
}
