/** Segmented control (radio group of buttons, 48px tall). */
export function Segmented<T extends string | number>({ label, value, options, onChange, size }: {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (v: T) => void; size?: 'lg';
}) {
  return (
    <div className={`segmented${size === 'lg' ? ' segmented-lg' : ''}`} role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
