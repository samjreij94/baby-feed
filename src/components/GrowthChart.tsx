import { useMemo } from 'react';
import { gramsToKg, WHO_MAX_MONTHS, WHO_PERCENTILES, whoLine } from '../ui/adapter';
import type { WeightUnit, WhoSex } from '../ui/types';
import { useWidth } from './Charts';

const LB_PER_KG = 2.2046226218;
const PAD = { l: 34, r: 34, t: 24, b: 40 };
const X_TICKS = [0, 3, 6, 9, 12, 15, 18, 21, 24];
const LABEL = { 3: '3rd', 15: '15th', 50: '50th', 85: '85th', 97: '97th' } as const;

export interface GrowthPoint { id: string; months: number; grams: number }

/**
 * Weight-by-age chart, 0–24 months: the WHO Child Growth Standards weight-for-age percentile lines for girls or boys
 * (3rd, 15th, 50th, 85th, 97th) with her logged weights on top. Display units only; data is stored in grams.
 */
export function GrowthChart({ unit, sex = 'girls', points, summary, height = 280 }: { unit: WeightUnit; sex?: WhoSex; points: readonly GrowthPoint[]; summary: string; height?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const conv = (kg: number) => (unit === 'kg' ? kg : kg * LB_PER_KG);
  const step = unit === 'kg' ? 2 : 4;
  const lo = unit === 'kg' ? 2 : 4;
  const lines = useMemo(() => WHO_PERCENTILES.map((p) => ({ p, pts: whoLine(p, 7, sex).map((q) => ({ x: q.months, y: conv(q.kg) })) })), [unit, sex]); // eslint-disable-line react-hooks/exhaustive-deps
  const tallest = Math.max(...lines.map((l) => Math.max(...l.pts.map((q) => q.y))), ...points.map((p) => conv(gramsToKg(p.grams))));
  const hi = Math.max(unit === 'kg' ? 16 : 36, Math.ceil(tallest / step) * step);
  const yTicks: number[] = [];
  for (let v = lo; v <= hi; v += step) yTicks.push(v);
  const iw = w - PAD.l - PAD.r;
  const ih = height - PAD.t - PAD.b;
  const X = (m: number) => PAD.l + (iw * m) / WHO_MAX_MONTHS;
  const Y = (v: number) => PAD.t + ih * (1 - (Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo));
  const path = (pts: readonly { x: number; y: number }[]) => pts.map((q, i) => `${i ? 'L' : 'M'}${X(q.x).toFixed(1)} ${Y(q.y).toFixed(1)}`).join('');
  const mine = points.map((p) => ({ x: p.months, y: conv(gramsToKg(p.grams)), id: p.id }));
  return (
    <div ref={ref} className="chart growth" data-testid="growth-chart" data-sex={sex}>
      <svg width={w} height={height} role="img" aria-label={summary}>
        <g className="axis">
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={PAD.l} x2={w - PAD.r} y1={Y(v)} y2={Y(v)} className={v === lo ? 'base' : 'grid'} />
              <text x={PAD.l - 6} y={Y(v) + 4} textAnchor="end">{v}</text>
            </g>
          ))}
          {X_TICKS.map((m) => (
            <text key={m} x={X(m)} y={height - PAD.b + 16} textAnchor="middle">{m}</text>
          ))}
          <text x={PAD.l + iw / 2} y={height - 6} textAnchor="middle">Age (months)</text>
          <text x={PAD.l - 6} y={PAD.t - 12} textAnchor="end">{unit}</text>
        </g>
        {lines.map(({ p, pts }) => (
          <g key={p} data-testid={`who-p${p}`}>
            <path d={path(pts)} className={`who-line${p === 50 ? ' who-50' : ''}`} />
            <text x={w - PAD.r + 4} y={Y(pts[pts.length - 1]!.y) + 4} className="who-label">{LABEL[p]}</text>
          </g>
        ))}
        {mine.length > 1 && <path d={path(mine)} className="line line-weight" />}
        {mine.map((q) => <circle key={q.id} cx={X(q.x)} cy={Y(q.y)} r={4.5} className="dot-weight" data-testid="weight-dot" />)}
      </svg>
    </div>
  );
}
