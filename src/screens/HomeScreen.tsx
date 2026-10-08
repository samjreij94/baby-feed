import { PersonTag } from '../components/PersonChip';
import { IconBottle, IconMoon, IconSun } from '../components/Icons';
import { useClock, useHomeVM } from '../ui/adapter';
import { fmtAgo, fmtAmount, fmtClock, fmtMinShort, fmtTime } from '../ui/format';
import { SIDE_NAME, type ActiveFeedVM, type Side, type Units } from '../ui/types';

export function HomeScreen({ units, night, active, onToggleNight, onStart, onBottle, onOpenTimer }: {
  units: Units; night: boolean; active: ActiveFeedVM | null;
  onToggleNight: () => void; onStart: (s: Side) => void; onBottle: () => void; onOpenTimer: () => void;
}) {
  const vm = useHomeVM(units);
  const now = useClock(30_000);
  const summary = vm.lastSummary;
  const ago = vm.sinceMs !== null ? fmtAgo(vm.sinceMs) : null;
  const dateLine = new Date(now).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });

  return (
    <div className="screen home" data-testid="home">
      <header className="top">
        <div>
          <div className="eyebrow">{dateLine}</div>
          <h1>{vm.babyName ?? 'Feeds'}</h1>
        </div>
        <button type="button" className="icon-btn" onClick={onToggleNight} aria-label={night ? 'Switch to day colours' : 'Switch to night colours'}>
          {night ? <IconSun /> : <IconMoon />}
        </button>
      </header>

      {active ? (
        <section className="card hero hero-live" aria-label="Feed in progress">
          <div className="caption">{active.status === 'paused' ? 'Paused' : 'Feeding now'}{active.startedByOther ? ` · started by ${active.startedBy.name}` : ''}</div>
          <div className="hero-value num">{fmtClock(active.elapsedMs)}</div>
          <div className="hero-meta">{SIDE_NAME[active.currentSide]} side · started {fmtTime(active.startedAt)}</div>
        </section>
      ) : vm.hasFeeds && ago ? (
        <section className="card hero" aria-label="Last feed" aria-live="polite">
          <div className="caption">Last fed</div>
          <div className="hero-value">
            <span className="num">{ago.value}</span> {ago.unit && <span className="hero-unit">{ago.unit}</span>}
          </div>
          <div className="hero-meta">
            <span>{fmtTime(vm.lastFedAt!)} · {summary}</span>
            {vm.lastBy && <PersonTag p={vm.lastBy} />}
          </div>
          <div className="hero-sides">
            <div className="side-cell">
              <div className="caption">Last side</div>
              <div className="side-val">{vm.lastSide ? <><b className={`side-dot side-${vm.lastSide}`}>{vm.lastSide}</b>{SIDE_NAME[vm.lastSide]}</> : '—'}</div>
            </div>
            <div className="side-cell next">
              <div className="caption">Next suggested</div>
              <div className="side-val">{vm.nextSide ? <><b className={`side-dot side-${vm.nextSide}`}>{vm.nextSide}</b>{SIDE_NAME[vm.nextSide]}</> : '—'}</div>
            </div>
          </div>
        </section>
      ) : (
        <section className="card hero">
          <div className="caption">No feeds yet</div>
          <div className="hero-empty">Tap Left or Right to start the timer, or log a bottle.</div>
        </section>
      )}

      <section className="today" aria-label="Today so far">
        <div><b className="num">{vm.today.feeds}</b><span>{vm.today.feeds === 1 ? 'feed' : 'feeds'} today</span></div>
        <div><b className="num">{fmtMinShort(vm.today.nursingMin)}</b><span>nursing</span></div>
        <div><b className="num">{fmtAmount(vm.today.bottleOz, units)}</b><span>bottle</span></div>
      </section>

      <div className="thumb-zone">
        {active ? (
          <button type="button" className="btn btn-primary btn-xl" onClick={onOpenTimer} data-testid="open-timer">
            Back to timer · <span className="num">{fmtClock(active.elapsedMs)}</span>
          </button>
        ) : (
          <div className="side-buttons">
            {(['L', 'R'] as const).map((s) => {
              const sug = vm.nextSide === s;
              return (
                <button key={s} type="button" className={`side-btn side-btn-${s}${sug ? ' suggested' : ''}`} onClick={() => onStart(s)} aria-label={`Start ${SIDE_NAME[s]} side${sug ? ' (suggested)' : ''}`}>
                  <span className="side-letter">{s}</span>
                  <span className="side-name">{SIDE_NAME[s]}</span>
                  {sug && <span className="sug-tag">Suggested</span>}
                </button>
              );
            })}
          </div>
        )}
        <button type="button" className="btn btn-bottle" onClick={onBottle}>
          <IconBottle /> Bottle
        </button>
      </div>
    </div>
  );
}
