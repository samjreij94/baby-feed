import { useEffect, useState } from 'react';
import { BarChart, LineChart, niceMinutes } from '../components/Charts';
import { BottomSheet } from '../components/BottomSheet';
import { IconMoon } from '../components/Icons';
import { Segmented } from '../components/Segmented';
import {
  useActiveSleepSession,
  useCore,
  useHousehold,
  useSleepMetrics,
  useSleepPlan,
  useSleepSessions,
  type SleepEvent,
  type SleepEventKind,
  type SleepIntervalRow,
  type SleepSession,
  type SleepSessionMetrics,
  type SleepSessionType,
  NAP_CAP_MS,
  type SleepTimerState,
} from '../core';
import { useClock } from '../ui/adapter';
import { fmtDayKey, fmtMin, fmtMinShort, fmtTime } from '../ui/format';
import { FERBER_RULES, fmtAgoPhrase, fmtCountdown, minutesToTimeInput, remoteSleepLine, timeInputToMinutes } from '../ui/sleep';

type Pane = 'tonight' | 'plan' | 'history';
const PANES = [
  { value: 'tonight' as const, label: 'Tonight' },
  { value: 'plan' as const, label: 'Plan' },
  { value: 'history' as const, label: 'History' },
];
const DIM_KEY = 'bf.ui.sleepDim.v1';

function loadDim(): boolean {
  try { return localStorage.getItem(DIM_KEY) === 'on'; } catch { return false; }
}

const NOTE_MAX = 1000;

function liveEvents(session: SleepSession | null | undefined): SleepEvent[] {
  if (!session) return [];
  return session.events
    .filter((e) => !e.deleted)
    .slice()
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
}

function liveNotes(session: SleepSession | null | undefined): SleepEvent[] {
  return liveEvents(session).filter((e) => e.kind === 'note' && (e.text ?? '').trim());
}

const EVENT_LABEL: Record<SleepEventKind, string> = {
  cry_start: 'Crying started',
  cry_stop: 'Crying stopped',
  check_start: 'Went in for a check',
  check_end: 'Check done, left the room',
  night_waking: 'Night waking logged',
  planned_night_feed: 'Planned feed logged',
  note: 'Note saved',
  asleep: 'Marked asleep',
};

function eventTitle(ev: SleepEvent): string {
  if (ev.kind === 'note') return ev.text?.trim() || 'Note saved';
  return EVENT_LABEL[ev.kind];
}

const UNDO_MS = 6000;

type UndoToast = { sessionId: string; eventId: string; label: string };

export function SleepScreen() {
  const [pane, setPane] = useState<Pane>(() => {
    const t = new URLSearchParams(location.search).get('sleep');
    return t === 'plan' || t === 'history' ? t : 'tonight';
  });
  const [dim, setDim] = useState(loadDim);
  const toggleDim = () => setDim((d) => {
    const next = !d;
    try { localStorage.setItem(DIM_KEY, next ? 'on' : 'off'); } catch { /* ignore */ }
    return next;
  });

  return (
    <div className={`screen sleep-screen${dim ? ' is-dim' : ''}`} data-testid="sleep">
      <header className="top">
        <h1>Sleep</h1>
        <button type="button" className={`btn btn-sm${dim ? ' btn-primary' : ''}`} aria-pressed={dim} onClick={toggleDim}>
          Dim
        </button>
      </header>
      <Segmented label="Sleep views" value={pane} options={PANES} onChange={setPane} />
      {pane === 'tonight' && <TonightPanel />}
      {pane === 'plan' && <PlanPanel />}
      {pane === 'history' && <HistoryPanel />}
    </div>
  );
}

function nightTitle(type: SleepSessionType | 'idle', timer: SleepTimerState | null, fallbackNight: number): string {
  const n = timer?.nightNumber ?? fallbackNight;
  const using = n > 7 ? ` · using N7 times` : '';
  if (type === 'nap') return `Nap · Night ${n}${using}`;
  return `Night ${n}${using}`;
}

function TonightPanel() {
  const now = useClock(1000);
  const core = useCore();
  const hh = useHousehold();
  const sleep = useActiveSleepSession();
  const { session, others, timer } = sleep;
  const [prefer, setPrefer] = useState<SleepSessionType>('night');
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [undo, setUndo] = useState<UndoToast | null>(null);
  const fail = (e: unknown) => console.warn('[sleep]', e);
  const id = session?.id;
  useEffect(() => {
    if (!undo) return;
    const t = window.setTimeout(() => setUndo(null), UNDO_MS);
    return () => window.clearTimeout(t);
  }, [undo]);
  const offerUndo = (next: SleepSession, kind: SleepEventKind, before: Set<string>) => {
    const ev = [...next.events].reverse().find((e) => e.kind === kind && !e.deleted && !before.has(e.id));
    if (ev) setUndo({ sessionId: next.id, eventId: ev.id, label: eventTitle(ev) });
  };
  const afterEvent = (kind: SleepEventKind) => {
    const before = new Set((session?.events ?? []).map((e) => e.id));
    return (next: SleepSession) => offerUndo(next, kind, before);
  };
  const go = (kind: SleepEventKind) => {
    if (!id) return Promise.resolve();
    return sleep.addSleepEvent(id, kind).then(afterEvent(kind)).catch(fail);
  };
  const closeNote = () => { setNoteOpen(false); setNoteText(''); };
  const saveNote = () => {
    const text = noteText.trim().slice(0, NOTE_MAX);
    if (!id || !text) return Promise.resolve();
    return sleep.addSleepEvent(id, 'note', { text }).then((next) => { closeNote(); afterEvent('note')(next); }).catch(fail);
  };
  const undoLast = () => {
    if (!undo) return Promise.resolve();
    const cur = undo;
    return sleep.deleteSleepEvent(cur.sessionId, cur.eventId).then(() => setUndo(null)).catch(fail);
  };
  const removeEvent = (eventId: string) => {
    if (!id) return Promise.resolve();
    return sleep.deleteSleepEvent(id, eventId).then(() => {
      setUndo((u) => (u && u.eventId === eventId ? null : u));
    }).catch(fail);
  };
  const events = liveEvents(session);

  const phase = timer?.phase ?? 'idle';
  const idle = !session;
  const mode: SleepSessionType = session?.type ?? prefer;
  const remote = remoteSleepLine(session, hh.me?.id ?? null, core.deviceId, now)
    ?? (others[0] ? remoteSleepLine(others[0], hh.me?.id ?? null, core.deviceId, now) : null);
  const due = phase === 'crying' && !!timer && timer.remainingMs <= 0;
  const napCapRemaining = timer?.napCapDueAt != null ? Math.max(0, timer.napCapDueAt - now) : null;

  return (
    <div className="sleep-tonight" data-testid="sleep-tonight">
      <p className="sleep-night-label" data-testid="sleep-night">{nightTitle(idle ? prefer : mode, timer, 1)}</p>
      {remote && (
        <div className="banner sleep-remote" role="status" data-testid="sleep-remote">
          <span>{remote}</span>
        </div>
      )}
      {others[0] && (
        <div className="banner banner-warn" role="status">
          <span className="grow"><b>{others[0].loggedBy.name}</b> also started a {others[0].type} at {fmtTime(others[0].startedAt)}</span>
        </div>
      )}

      {idle && (
        <Segmented
          label="Session type"
          value={prefer}
          options={[{ value: 'night', label: 'Tonight' }, { value: 'nap', label: 'Nap' }]}
          onChange={setPrefer}
        />
      )}

      {timer?.napCapDueAt != null && phase !== 'asleep' && phase !== 'ended' && (
        <div className={`sleep-napcap${phase === 'nap_capped' ? ' is-due' : ''}`} role="status" data-testid="sleep-napcap">
          {phase === 'nap_capped' || (napCapRemaining ?? 1) <= 0
            ? 'Nap cap reached (60 min) — go get her.'
            : `Nap cap in ${fmtCountdown(napCapRemaining!, NAP_CAP_MS)}`}
        </div>
      )}

      {(due || phase === 'checking') && (
        <section className="card sleep-goin" data-testid="sleep-goin">
          <p className="sleep-goin-kicker">
            {phase === 'checking' ? `Check #${timer!.checkIndex} — you’re in the room` : `Check #${timer!.checkIndex} is due`}
          </p>
          <h2>Go in: 1–2 min, lights off, pat/shush, don’t pick up</h2>
          {phase === 'checking' ? (
            <button type="button" className="btn btn-xl btn-primary sleep-hero-btn" onClick={() => go('check_end')}>
              Check done, I’ve left
            </button>
          ) : (
            <button type="button" className="btn btn-xl btn-primary sleep-hero-btn" onClick={() => go('check_start')}>
              I’m going in
            </button>
          )}
        </section>
      )}

      {phase === 'crying' && timer && !due && (
        <section className="card sleep-timer" data-testid="sleep-countdown">
          <p className="eyebrow">Check #{timer.checkIndex} in</p>
          <p className="sleep-count num" aria-live="polite">{fmtCountdown(timer.remainingMs, timer.intervalMs)}</p>
          <p className="dim small">Wait {Math.round(timer.intervalMs / 60_000)} min this interval</p>
        </section>
      )}

      {phase === 'asleep' && (
        <section className="card sleep-asleep" data-testid="sleep-asleep">
          <p className="sleep-asleep-title">She’s asleep</p>
          {session?.asleepAt && <p className="dim">{fmtTime(session.asleepAt)} · {fmtAgoPhrase(now - session.asleepAt)}</p>}
        </section>
      )}

      {phase === 'pre_putdown' && (
        <p className="dim small sleep-started">Started at {fmtTime(session!.startedAt)} — put her down when you’re ready.</p>
      )}
      {phase === 'quiet' && session?.putDownAt && (
        <p className="dim small sleep-started">{mode === 'nap' ? 'Nap' : 'Put down'} at {fmtTime(session.putDownAt)}</p>
      )}

      <div className="sleep-actions">
        {idle && prefer === 'night' && (
          <button
            type="button"
            className="btn btn-xl btn-primary sleep-hero-btn"
            onClick={() => sleep.startSleepSession({ type: 'night' }).then((s) => sleep.setPutDown(s.id)).catch(fail)}
          >
            <IconMoon /> Start bedtime / Put down
          </button>
        )}
        {idle && prefer === 'nap' && (
          <button
            type="button"
            className="btn btn-xl btn-primary sleep-hero-btn"
            onClick={() => sleep.startSleepSession({ type: 'nap' }).then((s) => sleep.setPutDown(s.id)).catch(fail)}
          >
            Start nap
          </button>
        )}

        {phase === 'pre_putdown' && id && (
          <button type="button" className="btn btn-xl btn-primary sleep-hero-btn" onClick={() => sleep.setPutDown(id).catch(fail)}>
            <IconMoon /> Put down
          </button>
        )}

        {session && phase !== 'asleep' && phase !== 'ended' && phase !== 'checking' && phase !== 'pre_putdown' && (
          <button
            type="button"
            className={`btn btn-xl sleep-hero-btn sleep-cry-btn${phase === 'crying' ? ' is-on' : ''}`}
            aria-pressed={phase === 'crying'}
            onClick={() => go(phase === 'crying' ? 'cry_stop' : 'cry_start')}
          >
            {phase === 'crying' ? 'Stop crying' : 'Crying'}
          </button>
        )}

        {session && phase !== 'ended' && (
          <div className="sleep-grid">
            {phase !== 'asleep' && id && (
              <button type="button" className="btn sleep-grid-btn" onClick={() => sleep.markAsleep(id).then(afterEvent('asleep')).catch(fail)}>Asleep</button>
            )}
            {mode === 'night' && (
              <button type="button" className="btn sleep-grid-btn" onClick={() => go('night_waking')}>Night waking</button>
            )}
            <button type="button" className="btn sleep-grid-btn" onClick={() => go('planned_night_feed')}>Planned feed</button>
            <button type="button" className="btn sleep-grid-btn" onClick={() => setNoteOpen(true)}>Note</button>
            {id && (
              <button type="button" className="btn sleep-grid-btn" onClick={() => sleep.endSleepSession(id).catch(fail)}>
                {mode === 'nap' ? 'End nap' : 'Morning (end)'}
              </button>
            )}
          </div>
        )}
      </div>

      {events.length > 0 && (
        <ul className="sleep-events" data-testid="sleep-events">
          {events.map((ev) => (
            <li key={ev.id} className="sleep-event">
              <div className="sleep-event-main">
                <span className="sleep-note-time">{fmtTime(ev.at)}</span>
                <span>{eventTitle(ev)}</span>
              </div>
              <button
                type="button"
                className="btn btn-quiet sleep-event-del"
                aria-label={`Delete ${eventTitle(ev)}`}
                onClick={() => removeEvent(ev.id)}
              >
                Delete
              </button>
            </li>
          ))}
        </ul>
      )}

      {undo && (
        <div className="sleep-undo" role="status" data-testid="sleep-undo">
          <span>{undo.label}</span>
          <button type="button" className="sleep-undo-btn" onClick={() => undoLast()}>Undo</button>
        </div>
      )}

      <BottomSheet
        open={noteOpen}
        onClose={closeNote}
        title="Note"
        footer={
          <button
            type="button"
            className="btn btn-lg btn-primary"
            disabled={!id || !noteText.trim()}
            onClick={() => saveNote()}
          >
            Save note
          </button>
        }
      >
        <label className="field">
          <div className="caption">Quick note for this session</div>
          <textarea
            className="input sleep-note-input"
            aria-label="Sleep note"
            value={noteText}
            maxLength={NOTE_MAX}
            rows={4}
            autoFocus
            placeholder="Lights, pacifier, a feeding…"
            onChange={(e) => setNoteText(e.target.value.slice(0, NOTE_MAX))}
          />
        </label>
      </BottomSheet>
    </div>
  );
}

function PlanPanel() {
  const { plan, setPlan, resetIntervals, saved } = useSleepPlan();
  const { timer, session, setNightNumberOverride } = useActiveSleepSession();
  const current = Math.min(timer?.nightNumber ?? 1, 7);
  const fail = (e: unknown) => console.warn('[sleep]', e);

  const setRow = (night: number, patch: Partial<SleepIntervalRow>) => {
    const intervals = plan.intervals.map((r) => (r.night === night ? { ...r, ...patch } : r));
    void setPlan({ intervals }).catch(fail);
  };

  return (
    <div className="sleep-plan" data-testid="sleep-plan">
      <label className="field sleep-date">
        <div className="caption">Plan start date</div>
        <input
          className="input"
          type="date"
          value={plan.startDate}
          aria-label="Plan start date"
          onChange={(e) => { if (e.target.value) void setPlan({ startDate: e.target.value }).catch(fail); }}
        />
      </label>
      <p className="dim small">{saved ? 'Synced to both phones.' : 'Defaults until you change something — then it syncs.'} Night 1 begins this evening. After Night 7, the last times stay in use.</p>

      <label className="field sleep-date">
        <div className="caption">Morning cutoff</div>
        <input
          className="input"
          type="time"
          value={minutesToTimeInput(plan.wakeCutoffMinutes)}
          aria-label="Morning cutoff"
          onChange={(e) => {
            const m = timeInputToMinutes(e.target.value);
            if (m !== null) void setPlan({ wakeCutoffMinutes: m }).catch(fail);
          }}
        />
      </label>
      <p className="dim small">A waking at or after this time ends the night (default 6:00 AM).</p>

      {session && timer && (
        <label className="field sleep-date">
          <div className="caption">Tonight’s night number</div>
          <input
            className="input"
            type="number"
            min={1}
            step={1}
            value={timer.nightNumber}
            aria-label="Night number override"
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1) void setNightNumberOverride(session.id, Math.floor(n)).catch(fail);
            }}
          />
        </label>
      )}

      <section className="card sleep-table-card">
        <h2>Check intervals</h2>
        <table className="sleep-table" data-testid="sleep-intervals">
          <thead>
            <tr>
              <th scope="col">Night</th>
              <th scope="col">1st</th>
              <th scope="col">2nd</th>
              <th scope="col">3rd+</th>
            </tr>
          </thead>
          <tbody>
            {plan.intervals.map((row) => {
              const on = row.night === current;
              return (
                <tr key={row.night} className={on ? 'is-current' : undefined} data-current={on || undefined}>
                  <th scope="row">N{row.night}{on ? ' · tonight' : ''}</th>
                  {(['firstMin', 'secondMin', 'laterMin'] as const).map((key) => (
                    <td key={key}>
                      <input
                        className="input sleep-int"
                        type="number"
                        min={0}
                        max={180}
                        inputMode="numeric"
                        aria-label={`Night ${row.night} ${key === 'firstMin' ? '1st' : key === 'secondMin' ? '2nd' : '3rd+'} interval, minutes`}
                        value={row[key]}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v)) setRow(row.night, { [key]: Math.max(0, Math.min(180, v)) });
                        }}
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <button type="button" className="btn btn-sm sleep-reset" onClick={() => void resetIntervals().catch(fail)}>Reset intervals to defaults</button>
        <p className="dim small">Naps are capped at 60 minutes.</p>
      </section>

      <section className="card">
        <h2>Rules to remember</h2>
        <ul className="sleep-rules">
          {FERBER_RULES.map((r) => <li key={r}>{r}</li>)}
        </ul>
      </section>
    </div>
  );
}

function HistoryPanel() {
  const { trend } = useSleepMetrics();
  const sessions = useSleepSessions();
  const notesBySession = new Map(sessions.map((s) => [s.id, liveNotes(s)]));
  const nights = trend.nights;
  const naps = trend.naps;

  if (!nights.length && !naps.length) {
    return (
      <div className="card empty" data-testid="sleep-history">
        Nights will show up here after you start bedtime.
      </div>
    );
  }

  return (
    <div className="sleep-history" data-testid="sleep-history">
      {nights.length > 0 && <NightCharts nights={nights} />}
      <section aria-label="Nights">
        <h2 className="day-head"><span>Nights</span><span className="dim num">{nights.length}</span></h2>
        {nights.length === 0 ? <p className="dim small">No nights logged yet.</p> : (
          <ul className="rows">
            {nights.slice().reverse().map((r) => <SummaryRow key={r.sessionId} row={r} notes={notesBySession.get(r.sessionId) ?? []} />)}
          </ul>
        )}
      </section>
      {naps.length > 0 && (
        <section aria-label="Naps">
          <h2 className="day-head"><span>Naps</span><span className="dim num">{naps.length}</span></h2>
          <ul className="rows">
            {naps.slice().reverse().map((r) => <SummaryRow key={r.sessionId} row={r} notes={notesBySession.get(r.sessionId) ?? []} />)}
          </ul>
        </section>
      )}
    </div>
  );
}

function SummaryRow({ row, notes }: { row: SleepSessionMetrics; notes: SleepEvent[] }) {
  const title = row.type === 'nap' ? 'Nap' : `Night ${row.nightNumber}`;
  const timeTo = row.timeToAsleepMs != null ? row.timeToAsleepMs / 60_000 : null;
  const crying = row.cryingMs / 60_000;
  const detail = [
    timeTo !== null ? `asleep in ${fmtMin(timeTo)}` : 'not yet asleep',
    `${fmtMinShort(crying)} crying`,
    `${row.checks} check${row.checks === 1 ? '' : 's'}`,
    `${row.wakings} waking${row.wakings === 1 ? '' : 's'}`,
  ].join(' · ');
  return (
    <li className="h-row sleep-hist-row">
      <div className="h-main">
        <span className="kind-ic kind-sleep" aria-hidden>{row.type === 'nap' ? 'n' : `N${Math.min(row.nightNumber, 7)}`}</span>
        <span className="h-text">
          <span className="h-title">{title}</span>
          <span className="h-detail h-wrap dim">{detail}</span>
        </span>
        <span className="h-when">
          <span className="num">{fmtDayKey(row.date)}</span>
          <span className="dim num">{fmtTime(row.startedAt)}</span>
        </span>
      </div>
      {notes.length > 0 && (
        <ul className="sleep-notes sleep-notes-hist" data-testid="sleep-hist-notes">
          {notes.map((n) => (
            <li key={n.id}>
              <span className="sleep-note-time">{fmtTime(n.at)}</span>
              <span>{n.text}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function NightCharts({ nights }: { nights: SleepSessionMetrics[] }) {
  const days = nights.map((r) => ({
    key: r.sessionId,
    tick: `N${r.nightNumber}`,
    label: `Night ${r.nightNumber}, ${fmtDayKey(r.date)}`,
  }));
  const fmt = (v: number) => (v === 0 ? '0' : fmtMinShort(v));
  const countFmt = (v: number) => String(Math.round(v));
  return (
    <div className="sleep-charts">
      <section className="card chart-card">
        <h2>Time to fall asleep <span className="dim unit">· min</span></h2>
        <LineChart
          title="Time to fall asleep"
          days={days}
          values={nights.map((r) => (r.timeToAsleepMs == null ? null : r.timeToAsleepMs / 60_000))}
          fmt={fmt}
          nice={niceMinutes}
          cls="line-sleep"
          height={140}
        />
      </section>
      <section className="card chart-card">
        <h2>Crying <span className="dim unit">· min</span></h2>
        <BarChart
          title="Crying minutes"
          days={days}
          series={[{ name: 'Crying', cls: 'bar-sleep-cry', values: nights.map((r) => r.cryingMs / 60_000) }]}
          fmt={fmt}
          nice={niceMinutes}
          height={140}
        />
      </section>
      <section className="card chart-card">
        <h2>Checks</h2>
        <BarChart
          title="Checks"
          days={days}
          series={[{ name: 'Checks', cls: 'bar-sleep', values: nights.map((r) => r.checks) }]}
          fmt={countFmt}
          height={140}
        />
      </section>
      <section className="card chart-card">
        <h2>Night wakings</h2>
        <BarChart
          title="Night wakings"
          days={days}
          series={[{ name: 'Wakings', cls: 'bar-sleep-wake', values: nights.map((r) => r.wakings) }]}
          fmt={countFmt}
          height={140}
        />
      </section>
    </div>
  );
}
