import { useEffect, useId, useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconChevronRight } from '../components/Icons';
import { InviteCard } from '../components/InviteCard';
import { PersonChip } from '../components/PersonChip';
import { Segmented } from '../components/Segmented';
import { useHouseholdVM, usePushCtx, useSyncVM } from '../ui/adapter';
import { disableReminders, enableReminders, reminderState, showTestNotification, type ReminderState } from '../ui/notify';
import type { NightPref, Prefs } from '../ui/types';

const NIGHT_OPTS = [{ value: 'auto', label: 'Auto' }, { value: 'on', label: 'On' }, { value: 'off', label: 'Off' }] as const;

const REMINDER_TEXT: Record<ReminderState, string> = {
  on: 'On. You’ll get a “Still feeding?” alert on this phone after 15 minutes of nursing, then every 15 minutes.',
  off: 'Off. Turn on to get a “Still feeding?” alert when a breastfeeding timer runs 15+ minutes.',
  denied: 'Blocked. Allow notifications for Baby Feed in iPhone Settings → Notifications, then come back.',
  'needs-install': 'On iPhone, reminders only work from the Home Screen app: in Safari tap Share → Add to Home Screen, open it from there, then turn this on.',
  unsupported: 'This browser can’t show background reminders. You’ll still get the in-app “Still feeding?” prompt.',
};

function ReminderCard() {
  const push = usePushCtx();
  const [state, setState] = useState<ReminderState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { void reminderState().then(setState); }, []);
  if (!state) return null;
  const run = async (fn: () => Promise<ReminderState>) => {
    setBusy(true); setErr(null);
    try { setState(await fn()); } catch (e) { setErr(e instanceof Error ? e.message : 'Something went wrong'); } finally { setBusy(false); }
  };
  return (
    <>
      <h2 className="section">Still feeding? reminders</h2>
      <div className="card stack">
        <div className="dim small" data-testid="reminder-text">{REMINDER_TEXT[state]}</div>
        {err && <div className="small" role="alert">{err}</div>}
        <div className="row">
          {state === 'on' ? (
            <>
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void showTestNotification().catch(() => setErr('Couldn’t show a test notification.'))}>Send test</button>
              <button type="button" className="btn btn-sm btn-quiet" disabled={busy || !push} onClick={() => push && void run(() => disableReminders(push))}>Turn off</button>
            </>
          ) : state === 'off' ? (
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || !push} onClick={() => push && void run(() => enableReminders(push))}>Turn on reminders</button>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** Text field that saves on blur / Enter. Caption is a <div>. */
function SaveField({ caption, value, placeholder, autoFocus, onSave }: { caption: string; value: string; placeholder?: string; autoFocus?: boolean; onSave: (v: string) => void }) {
  const id = useId();
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="field">
      <div className="caption" id={id}>{caption}</div>
      <input className="input" aria-labelledby={id} value={v} placeholder={placeholder} maxLength={24} autoFocus={autoFocus}
        onChange={(e) => setV(e.target.value)} onBlur={() => v.trim() !== value && onSave(v.trim())} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </div>
  );
}

export function SettingsScreen({ prefs, night, onPrefs, onLeft, onImport, focusBaby = false }: { prefs: Prefs; night: boolean; onPrefs: (p: Partial<Prefs>) => void; onLeft: () => void; onImport: () => void; focusBaby?: boolean }) {
  const [hh, act] = useHouseholdVM();
  const sync = useSyncVM();
  const [leave, setLeave] = useState(false);
  return (
    <div className="screen" data-testid="settings">
      <header className="top"><h1>Settings</h1></header>

      <h2 className="section">You</h2>
      <div className="card stack-lg">
        <SaveField caption="Your name" value={hh.me?.name ?? ''} onSave={(n) => n && void act.setMyName(n)} />
        <SaveField caption="Baby’s name" value={hh.babyName ?? ''} placeholder="Add a name" autoFocus={focusBaby && !hh.babyName} onSave={(n) => void act.setBabyName(n || null)} />
        <div className="dim small field-note">Shared with both phones.</div>
      </div>

      <h2 className="section">Night mode</h2>
      <div className="card stack">
        <Segmented label="Night mode" value={prefs.night} options={NIGHT_OPTS} onChange={(n: NightPref) => onPrefs({ night: n })} />
        <div className="dim small">{prefs.night === 'auto' ? `Dims automatically from 8 PM to 7 AM. ${night ? 'Night colours are on now.' : 'Day colours are on now.'}` : prefs.night === 'on' ? 'Night colours stay on.' : 'Day colours stay on.'}</div>
      </div>

      <ReminderCard />

      <h2 className="section">Household</h2>
      <div className="card stack-lg">
        <div className="members">
          {hh.members.map((m) => (
            <span key={m.id} className="member"><PersonChip p={m} size="sm" />{m.name}{m.isMe && <span className="dim"> (you)</span>}</span>
          ))}
        </div>
        {hh.code && hh.link ? <InviteCard code={hh.code} link={hh.link} showQr={false} /> : <div className="dim">Not in a household.</div>}
      </div>

      <h2 className="section">Sync</h2>
      <div className="card row">
        <span className={`sync-dot sync-${sync.state}`} aria-hidden />
        <span className="grow">{sync.text}{sync.pending ? ` · ${sync.pending} waiting` : ''}</span>
        <button type="button" className="btn btn-sm" onClick={() => void sync.syncNow()}>Sync now</button>
      </div>

      <h2 className="section">Your data</h2>
      <button type="button" className="card nav-row" onClick={onImport}>
        <span className="grow">
          <span className="nav-title">Import from Nara</span>
          <span className="dim small">Bring in feeds from a Nara Baby CSV export</span>
        </span>
        <IconChevronRight width={20} height={20} aria-hidden />
      </button>

      <button type="button" className="btn btn-danger btn-block leave" onClick={() => setLeave(true)}>Leave household on this phone</button>
      <p className="dim small center">Baby Feed · feeds stay on this phone if you leave.</p>

      {leave && (
        <ConfirmDialog title="Leave household?" body="This phone stops syncing. Your partner keeps everything. You can join again with the code."
          confirmLabel="Leave" danger onCancel={() => setLeave(false)} onConfirm={() => { setLeave(false); void act.leave().then(onLeft); }} />
      )}
    </div>
  );
}
