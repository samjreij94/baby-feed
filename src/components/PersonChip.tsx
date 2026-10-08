import type { PersonVM } from '../ui/types';

export function PersonTag({ p }: { p: PersonVM }) {
  return (
    <span className="person-tag" aria-label={`Logged by ${p.isMe ? `${p.name} (you)` : p.name}`}>
      <span className={`chip chip-sm tone-${p.tone}`} aria-hidden>{p.initials}</span>
      <span aria-hidden>{p.isMe ? 'You' : p.name}</span>
    </span>
  );
}

export function PersonChip({ p, size }: { p: PersonVM; size?: 'sm' }) {
  return (
    <span className={`chip tone-${p.tone}${size === 'sm' ? ' chip-sm' : ''}`} title={`Logged by ${p.name}`} aria-label={`Logged by ${p.isMe ? `${p.name} (you)` : p.name}`}>
      {p.initials}
    </span>
  );
}
