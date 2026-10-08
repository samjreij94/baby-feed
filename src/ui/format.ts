/** Pure display formatting. No core imports. */
import type { Units } from './types';

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pad = (n: number) => String(n).padStart(2, '0');

/** Timer readout: "07:05", or "1:02:09" past an hour. */
export function fmtClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** Duration in minutes: "45 sec" < 1 min, "16 min", "1h 42m". */
export function fmtMin(min: number): string {
  if (min > 0 && min < 1) return `${Math.max(1, Math.round(min * 60))} sec`;
  const m = Math.round(min);
  if (m < 60) return `${m}\u00a0min`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}

/** Compact duration: "9m", "1h 5m". */
export function fmtMinShort(min: number): string {
  if (min > 0 && min < 0.5) return '<1m';
  const m = Math.round(min);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "Last fed X ago" parts. */
export function fmtAgo(ms: number): { value: string; unit: string } {
  const min = Math.floor(Math.max(0, ms) / 60000);
  if (min < 1) return { value: 'Just now', unit: '' };
  if (min < 60) return { value: `${min}`, unit: min === 1 ? 'minute ago' : 'minutes ago' };
  const h = Math.floor(min / 60);
  return { value: `${h}h ${pad(min % 60)}m`, unit: 'ago' };
}

export const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

export function dateKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function addDays(dayStart: number, n: number): number {
  const d = new Date(dayStart);
  d.setDate(d.getDate() + n);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const keyToDate = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

export function dayLabel(key: string, now: number): string {
  if (key === dateKey(now)) return 'Today';
  if (key === dateKey(addDays(startOfDay(now), -1))) return 'Yesterday';
  const d = keyToDate(key);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

export const longDayLabel = (key: string) => keyToDate(key).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
export const weekdayInitial = (key: string) => keyToDate(key).toLocaleDateString([], { weekday: 'narrow' });
export const dayOfMonth = (key: string) => String(keyToDate(key).getDate());

export const OZ_TO_ML = 29.5735;
const trimNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ''));
/** "3.5 oz" / "105 ml" (ml rounded to 5). */
export function fmtAmount(oz: number, units: Units): string {
  if (units === 'ml') return `${Math.round((oz * OZ_TO_ML) / 5) * 5} ml`;
  return `${trimNum(Math.round(oz * 100) / 100)} oz`;
}
export const fmtOzNum = (oz: number) => trimNum(Math.round(oz * 100) / 100);

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 1).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** "datetime-local" value in local time. */
export function toLocalInput(t: number): string {
  const d = new Date(t);
  return `${dateKey(t)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return null;
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!).getTime();
}
