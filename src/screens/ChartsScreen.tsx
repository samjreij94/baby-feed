import { BarChart, LineChart, niceMinutes, SplitBar } from '../components/Charts';
import { Segmented } from '../components/Segmented';
import { useChartsVM } from '../ui/adapter';
import { fmtAmount, fmtMinShort, OZ_TO_ML } from '../ui/format';
import { useChartRange } from '../ui/prefs';
import type { ChartRange, Units } from '../ui/types';

const RANGES: readonly { value: ChartRange; label: string }[] = [{ value: 7, label: '7 days' }, { value: 14, label: '14 days' }, { value: 30, label: '30 days' }, { value: 'all', label: 'All' }];
/** Min px between x-axis labels for All-time week ('Jun 15') / month ('Jun') ticks. */
const TICK_PX = { day: 0, week: 46, month: 30 } as const;
/** Axis label for a minutes value on an axis whose max is `max` (hours once the axis passes 1h). */
const minTick = (max: number) => (v: number) => (v === 0 ? '0' : max > 60 ? `${+(v / 60).toFixed(1)}h` : `${Math.round(v)}m`);
/** Bar label: "48m" under an hour, "1.9h" above. */
const minLabel = (v: number) => (v < 60 ? `${Math.round(v)}m` : `${(v / 60).toFixed(1)}h`);

export function ChartsScreen({ units }: { units: Units }) {
  const [range, setRange] = useChartRange();
  const vm = useChartsVM(range);
  const at = vm.allTime;
  const minTickPx = at ? TICK_PX[vm.bucket] : 0;
  /** Under each chart title in All mode: what a bar is. */
  const cap = at && vm.bucket !== 'day' ? <div className="chart-cap dim small">{vm.bucket === 'week' ? 'Per week · daily average' : 'Per month · daily average'}</div> : null;
  const showCharts = !at || vm.days.length > 0;
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

      {at && vm.days.length > 0 && (
        <div className="range-note" data-testid="all-time-note">
          <div><b>{at.rangeText}</b></div>
          <div className="dim small">{at.barCaption}.</div>
          {at.partialNote && <div className="dim small">{at.partialNote}</div>}
        </div>
      )}

      {!vm.hasData && <div className="card empty">{at ? 'No feeds logged yet. Charts start from your first feed.' : 'No feeds in this range yet.'}</div>}

      {showCharts && (<>

      <section className="card chart-card">
        <h2>Nursing time per day</h2>
        {cap}
        <div className="legend"><span><i className="sw sw-l" />Left</span><span><i className="sw sw-r" />Right</span></div>
        <BarChart title="Nursing minutes per day" days={vm.days} valueLabels={lbl} nice={niceMinutes} fmt={minTick(nurseMax)} valueFmt={minLabel} minTickPx={minTickPx}
          series={[{ name: 'Left', cls: 'bar-l', values: vm.days.map((d) => d.leftMin) }, { name: 'Right', cls: 'bar-r', values: vm.days.map((d) => d.rightMin) }]} />
      </section>

      <section className="card chart-card">
        <h2>Left vs right</h2>
        <SplitBar left={vm.split.L} right={vm.split.R} leftLabel={fmtMinShort(vm.split.leftMin)} rightLabel={fmtMinShort(vm.split.rightMin)} />
      </section>

      <section className="card chart-card">
        <h2>Feeds per day</h2>
        {cap}
        <BarChart title="Feeds per day" days={vm.days} valueLabels={lbl} fmt={(v) => `${Math.round(v)}`} valueFmt={(v) => `${+v.toFixed(1)}`} minTickPx={minTickPx} series={[{ name: 'Feeds', cls: 'bar-feeds', values: vm.days.map((d) => d.feeds) }]} />
      </section>

      <section className="card chart-card">
        <h2>Bottle per day <span className="dim unit">({units})</span></h2>
        {cap}
        <BarChart title={`Bottle ${units} per day`} days={vm.days} valueLabels={lbl} fmt={amtAxis} minTickPx={minTickPx} series={[{ name: 'Bottle', cls: 'bar-bottle', values: vm.days.map((d) => d.bottleOz) }]} />
      </section>

      <section className="card chart-card">
        <h2>Average gap between feeds</h2>
        <div className="dim small">Start to start · gaps over 12h left out{at && vm.bucket !== 'day' ? ` · per ${vm.bucket}` : ''} · range average {vm.avg.gapMin === null ? '—' : fmtMinShort(vm.avg.gapMin)}</div>
        <LineChart title="Average gap between feeds" days={vm.days} values={vm.days.map((d) => d.avgGapMin)} nice={niceMinutes} fmt={minTick(gapMax)} cls="line-gap" minTickPx={minTickPx} />
      </section>
      </>)}
    </div>
  );
}
