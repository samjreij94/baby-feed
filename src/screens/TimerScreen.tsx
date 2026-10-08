import { useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconChevronDown, IconPause, IconPlay, IconStop, IconSwitch } from '../components/Icons';
import { PersonChip } from '../components/PersonChip';
import { fmtClock, fmtTime } from '../ui/format';
import { SIDE_NAME, type ActiveFeedVM } from '../ui/types';

export function TimerScreen({ feed, disabled = false, onHide, onSwitch, onPause, onResume, onEnd, onEndOther, onDiscard }: {
  feed: ActiveFeedVM; disabled?: boolean; onHide: () => void; onSwitch: () => void; onPause: () => void; onResume: () => void; onEnd: () => void; onEndOther: (id: string) => void; onDiscard: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  const paused = feed.status === 'paused';
  const other = feed.currentSide === 'L' ? 'R' : 'L';
  return (
    <div className={`timer-screen${paused ? ' is-paused' : ''}`} data-testid="timer">
      <header className="timer-top">
        <button type="button" className="btn btn-quiet icon-text" onClick={onHide} aria-label="Hide timer (keeps running)">
          <IconChevronDown /> Hide
        </button>
        <button type="button" className="btn btn-quiet" disabled={disabled} onClick={() => setConfirm(feed.id)}>Discard</button>
      </header>

      {feed.startedByOther && (
        <div className="banner" role="status">
          <PersonChip p={feed.startedBy} size="sm" />
          <span><b>{feed.startedBy.name}</b> started this feed at {fmtTime(feed.startedAt)}</span>
        </div>
      )}
      {feed.conflict && (
        <div className="banner banner-warn banner-conflict" role="status" data-testid="also-started">
          <PersonChip p={feed.conflict.by} size="sm" />
          <span className="grow">{feed.conflict.by.isMe ? 'You' : <b>{feed.conflict.by.name}</b>} also started a feed at {fmtTime(feed.conflict.startedAt)}</span>
          <span className="banner-actions">
            <button type="button" className="btn btn-sm" disabled={disabled} onClick={() => onEndOther(feed.conflict!.id)}>End</button>
            <button type="button" className="btn btn-sm btn-quiet" disabled={disabled} onClick={() => setConfirm(feed.conflict!.id)}>Discard</button>
          </span>
        </div>
      )}

      <div className="timer-main">
        <div className={`now-side side-${feed.currentSide}`}>
          <b className={`side-dot side-${feed.currentSide}`}>{feed.currentSide}</b>
          {paused ? `Paused · ${SIDE_NAME[feed.currentSide]}` : `${SIDE_NAME[feed.currentSide]} side`}
        </div>
        <div className="clock num" aria-label={`Total ${fmtClock(feed.elapsedMs)}`} aria-live="off">{fmtClock(feed.elapsedMs)}</div>
        <div className="dim">Total · started {fmtTime(feed.startedAt)}</div>
      </div>

      <div className="side-tiles">
        {(['L', 'R'] as const).map((s) => (
          <div key={s} className={`side-tile side-tile-${s}${feed.currentSide === s && !paused ? ' current' : ''}`}>
            <div className="caption">{SIDE_NAME[s]}</div>
            <div className="num tile-time">{fmtClock(feed.sideMs[s])}</div>
          </div>
        ))}
      </div>

      <div className="timer-actions">
        <button type="button" className="btn btn-xl btn-switch" disabled={disabled} onClick={onSwitch}>
          <IconSwitch /> Switch to {SIDE_NAME[other]}
        </button>
        <div className="row2">
          {paused ? (
            <button type="button" className="btn btn-lg" disabled={disabled} onClick={onResume}><IconPlay /> Resume</button>
          ) : (
            <button type="button" className="btn btn-lg" disabled={disabled} onClick={onPause}><IconPause /> Pause</button>
          )}
          <button type="button" className="btn btn-lg btn-primary" disabled={disabled} onClick={onEnd}><IconStop /> End &amp; save</button>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title="Discard this feed?"
          body={confirm === feed.id ? 'The timer stops and nothing is saved.' : 'That timer is removed on both phones and nothing is saved.'}
          confirmLabel="Discard"
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => { onDiscard(confirm); setConfirm(null); }}
        />
      )}
    </div>
  );
}
