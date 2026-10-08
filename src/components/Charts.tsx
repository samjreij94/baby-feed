import { useLayoutEffect, useRef, useState } from 'react';

/** Container width (ResizeObserver) so SVG text renders at true pixel size on every phone. */
function useWidth<T extends HTMLElement>(fallback = 340) {
  const ref = useRef<T>(null);
  const [w, setW] = useState(fallback);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => el.clientWidth && setW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

/** Rounds up to a friendly axis max (1, 2, 2.5, 5 × 10^n). */
export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}

/** Minute axes: 10/15/20/30/45/60 min, then whole hours (so ticks read 0 · 1.5h · 3h, never 1.7h). */
export function niceMinutes(v: number): number {
  if (v <= 0) return 60;
  for (const m of [10, 15, 20, 30, 45, 60]) if (m >= v) return m;
  return Math.ceil(v / 60) * 60;
}

export interface ChartDay { key: string; tick: string; label: string }
export interface Series { name: string; cls: string; values: readonly number[] }

const PAD = { l: 34, r: 6, t: 18, b: 22 };
const tickEvery = (n: number) => (n <= 7 ? 1 : n <= 14 ? 2 : 5);

function Axis({ w, h, max, fmt }: { w: number; h: number; max: number; fmt: (v: number) => string }) {
  const ih = h - PAD.t - PAD.b;
  return (
    <g className="axis">
      {[0, 0.5, 1].map((f) => {
        const y = PAD.t + ih * (1 - f);
        return (
          <g key={f}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y} y2={y} className={f === 0 ? 'base' : 'grid'} />
            <text x={PAD.l - 6} y={y + 4} textAnchor="end">{fmt(max * f)}</text>
          </g>
        );
      })}
    </g>
  );
}

function XTicks({ days, w, h }: { days: readonly ChartDay[]; w: number; h: number }) {
  const n = days.length;
  const band = (w - PAD.l - PAD.r) / n;
  const every = tickEvery(n);
  return (
    <g className="axis">
      {days.map((d, i) => ((n - 1 - i) % every === 0 ? (
        <text key={d.key} x={PAD.l + band * (i + 0.5)} y={h - 6} textAnchor="middle" className={i === n - 1 ? 'today' : undefined}>{d.tick}</text>
      ) : null))}
    </g>
  );
}

/** Stacked bar chart, one bar per day. */
export function BarChart({ days, series, fmt, valueFmt = fmt, nice = niceMax, title, height = 168, valueLabels }: {
  days: readonly ChartDay[]; series: readonly Series[]; fmt: (v: number) => string; valueFmt?: (v: number) => string; nice?: (v: number) => number; title: string; height?: number; valueLabels?: boolean;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = days.length;
  const totals = days.map((_, i) => series.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const max = nice(Math.max(0, ...totals));
  const ih = height - PAD.t - PAD.b;
  const band = (w - PAD.l - PAD.r) / n;
  const bw = Math.max(3, Math.min(28, band * (n > 14 ? 0.66 : 0.58)));
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label={`${title}: ${days.map((d, i) => `${d.label} ${valueFmt(totals[i]!)}`).join(', ')}`}>
        <Axis w={w} h={height} max={max} fmt={fmt} />
        {days.map((d, i) => {
          let y = PAD.t + ih;
          const x = PAD.l + band * i + (band - bw) / 2;
          return (
            <g key={d.key}>
              {series.map((s) => {
                const v = s.values[i] ?? 0;
                if (v <= 0) return null;
                const bh = Math.max(1.5, (v / max) * ih);
                y -= bh;
                return <rect key={s.name} x={x} y={y} width={bw} height={bh} rx={Math.min(3, bw / 3)} className={s.cls} />;
              })}
              {valueLabels && totals[i]! > 0 && <text x={x + bw / 2} y={y - 5} textAnchor="middle" className="val">{valueFmt(totals[i]!)}</text>}
            </g>
          );
        })}
        <XTicks days={days} w={w} h={height} />
      </svg>
    </div>
  );
}

/** Line with dots; null values break the line. */
export function LineChart({ days, values, fmt, nice = niceMax, title, cls, height = 150 }: {
  days: readonly ChartDay[]; values: readonly (number | null)[]; fmt: (v: number) => string; nice?: (v: number) => number; title: string; cls: string; height?: number;
}) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = days.length;
  const max = nice(Math.max(0, ...values.map((v) => v ?? 0)));
  const ih = height - PAD.t - PAD.b;
  const band = (w - PAD.l - PAD.r) / n;
  const pt = (i: number, v: number) => [PAD.l + band * (i + 0.5), PAD.t + ih * (1 - v / max)] as const;
  let d = '';
  values.forEach((v, i) => {
    if (v === null) return;
    const [x, y] = pt(i, v);
    d += `${i > 0 && values[i - 1] !== null ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
  });
  return (
    <div ref={ref} className="chart">
      <svg width={w} height={height} role="img" aria-label={`${title}: ${days.map((dd, i) => `${dd.label} ${values[i] === null ? 'no data' : fmt(values[i]!)}`).join(', ')}`}>
        <Axis w={w} h={height} max={max} fmt={fmt} />
        <path d={d} className={`line ${cls}`} />
        {values.map((v, i) => (v === null ? null : <circle key={days[i]!.key} cx={pt(i, v)[0]} cy={pt(i, v)[1]} r={n > 14 ? 2.5 : 3.5} className={`dot ${cls}`} />))}
        <XTicks days={days} w={w} h={height} />
      </svg>
    </div>
  );
}

/** Horizontal Left vs Right share bar. */
export function SplitBar({ left, right, leftLabel, rightLabel }: { left: number; right: number; leftLabel: string; rightLabel: string }) {
  const lp = Math.round(left * 100);
  const rp = left + right > 0 ? 100 - lp : 0;
  return (
    <div className="split">
      <div className="split-bar" role="img" aria-label={`Left ${lp}%, Right ${rp}%`}>
        <div className="fill-l" style={{ width: `${lp}%` }} />
        <div className="fill-r" style={{ width: `${rp}%` }} />
      </div>
      <div className="split-legend">
        <span><i className="sw sw-l" />Left <b className="num">{lp}%</b> <span className="dim">{leftLabel}</span></span>
        <span><i className="sw sw-r" />Right <b className="num">{rp}%</b> <span className="dim">{rightLabel}</span></span>
      </div>
    </div>
  );
}
