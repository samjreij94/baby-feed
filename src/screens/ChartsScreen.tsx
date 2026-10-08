import { useState } from 'react';
import { BarChart, LineChart, niceMinutes, SplitBar } from '../components/Charts';
import { Segmented } from '../components/Segmented';
import { useChartsVM } from '../ui/adapter';
import { fmtAmount, fmtMinShort, OZ_TO_ML } from '../ui/format';
import type { RangeDays, Units } from '../ui/types';

const RANGES = [{ value: 7, label: '7 days' }, { value: 14, label: '14 days' }, { value: 30, label: '30 days' }] as const;
/** Axis label for a minutes value on an axis whose max is `max` (hours once the axis passes 1h). */
const minTick = (max: number) => (v: number) => (v === 0 ? '0' : max > 60 ? `${+(v / 60).toFixed(1)}h` : `${Math.round(v)}m`);
/** Bar label: "48m" under an hour, "1.9h" above. */
const minLabel = (v: number) => (v < 60 ? `${Math.round(v)}m` : `${(v / 60).toFixed(1)}h`);

export function ChartsScreen({ units, initialRange = 7 }: { units: Units; initialRange?: RangeDays }) {
  const [range, setRange] = useState<RangeDays>(initialRange);
  const vm = useChartsVM(range);
  const ml = units === 'ml';
  const amtAxis = (oz: number) => (ml ? `${Math.round(oz * OZ_TO_ML)}` : `${+oz.toFixed(1)}`);
  const lbl = vm.range === 7;
  const nurseMax = niceMinutes(Math.max(0, ...vm.days.map((d) => d.nursingMin)));
  const gapMax = niceMinutes(Math.max(0, ...vm.days.map((d) => d.avgGapMin ?? 0)));
  return (
    <div className="screen" data-testid="charts">
      <header className="top"><h1>Charts</h1></header>
      <Segmented label="Range" value={range} options={RANGES} onChange={setRange} />

      <div className="stats">
        <div className="stat"><b className="num">{vm.avg.feedsPerDay}</b><span>feeds / day</span></div>
        <div className="stat"><b className="num">{fmtMinShort(vm.avg.nursingMinPerDay)}</b><span>nursing / day</span></div>
        <div className="stat"><b className="num">{vm.avg.gapMin === null ? '—' : fmtMinShort(vm.avg.gapMin)}</b><span>avg gap</span></div>
        <div className="stat"><b className="num">{fmtAmount(vm.avg.bottleOzPerDay, units)}</b><span>bottle / day</span></div>
      </div>

      {!vm.hasData && <div className="card empty">No feeds in this range yet.</div>}

      <section className="card chart-card">
        <h2>Nursing time per day</h2>
        <div className="legend"><span><i className="sw sw-l" />Left</span><span><i className="sw sw-r" />Right</span></div>
        <BarChart title="Nursing minutes per day" days={vm.days} valueLabels={lbl} nice={niceMinutes} fmt={minTick(nurseMax)} valueFmt={minLabel}
          series={[{ name: 'Left', cls: 'bar-l', values: vm.days.map((d) => d.leftMin) }, { name: 'Right', cls: 'bar-r', values: vm.days.map((d) => d.rightMin) }]} />
      </section>

      <section className="card chart-card">
        <h2>Left vs right</h2>
        <SplitBar left={vm.split.L} right={vm.split.R} leftLabel={fmtMinShort(vm.split.leftMin)} rightLabel={fmtMinShort(vm.split.rightMin)} />
      </section>

      <section className="card chart-card">
        <h2>Feeds per day</h2>
        <BarChart title="Feeds per day" days={vm.days} valueLabels={lbl} fmt={(v) => `${Math.round(v)}`} series={[{ name: 'Feeds', cls: 'bar-feeds', values: vm.days.map((d) => d.feeds) }]} />
      </section>

      <section className="card chart-card">
        <h2>Bottle per day <span className="dim unit">({units})</span></h2>
        <BarChart title={`Bottle ${units} per day`} days={vm.days} valueLabels={lbl} fmt={amtAxis} series={[{ name: 'Bottle', cls: 'bar-bottle', values: vm.days.map((d) => d.bottleOz) }]} />
      </section>

      <section className="card chart-card">
        <h2>Average gap between feeds</h2>
        <div className="dim small">Start to start · range average {vm.avg.gapMin === null ? '—' : fmtMinShort(vm.avg.gapMin)}</div>
        <LineChart title="Average gap between feeds" days={vm.days} values={vm.days.map((d) => d.avgGapMin)} nice={niceMinutes} fmt={minTick(gapMax)} cls="line-gap" />
      </section>
    </div>
  );
}
