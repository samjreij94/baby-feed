import { useId, useState } from 'react';

const PRESETS = ['Samir', 'Karyn'];

/** Samir / Karyn / Other… then a text field for a custom name. */
export function NamePicker({ caption, value, onChange }: { caption: string; value: string; onChange: (v: string) => void }) {
  const id = useId();
  const [custom, setCustom] = useState(() => value !== '' && !PRESETS.includes(value));
  return (
    <div className="field">
      <div className="caption" id={id}>{caption}</div>
      <div className="choice-row" role="radiogroup" aria-labelledby={id}>
        {PRESETS.map((p) => (
          <button key={p} type="button" role="radio" className="choice" aria-checked={!custom && value === p} onClick={() => { setCustom(false); onChange(p); }}>{p}</button>
        ))}
        <button type="button" role="radio" className="choice" aria-checked={custom} onClick={() => { setCustom(true); if (PRESETS.includes(value)) onChange(''); }}>Other…</button>
      </div>
      {custom && (
        <input className="input" aria-label="Your name" placeholder="Your name" autoComplete="given-name" autoFocus value={value} onChange={(e) => onChange(e.target.value)} maxLength={24} />
      )}
    </div>
  );
}
