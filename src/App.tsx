import { useCallback, useEffect, useRef, useState } from 'react';
import { EntrySheet, newBottleDraft, newBreastDraft, type SheetMode } from './components/EntrySheet';
import { ConfirmDialog } from './components/ConfirmDialog';
import { TabBar, type Tab } from './components/TabBar';
import { Toast } from './components/Toast';
import { ChartsScreen } from './screens/ChartsScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { HomeScreen } from './screens/HomeScreen';
import { NaraImportScreen } from './screens/NaraImportScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SetupScreen } from './screens/SetupScreen';
import { TimerScreen } from './screens/TimerScreen';
import { IconDrop } from './components/Icons';
import { FeedAlreadyRunning, readJoinFromUrl, useActions, useActiveFeedVM, useHouseholdVM, useReady } from './ui/adapter';
import { fmtClock } from './ui/format';
import { usePrefs } from './ui/prefs';
import { useTheme } from './ui/theme';
import type { EntryDraft } from './ui/types';
import './ui/styles/app.css';

const initialTab = (): Tab => {
  const t = new URLSearchParams(location.search).get('tab');
  return t === 'history' || t === 'charts' || t === 'settings' || t === 'import' ? (t === 'import' ? 'settings' : t) : 'home';
};

/** Calm placeholder while IndexedDB loads (usually a blink). Identity + a running timer never wait for this. */
function Loading() {
  return (
    <div className="loading" role="status" aria-live="polite" data-testid="loading">
      <span className="brand-ic loading-ic"><IconDrop width={30} height={30} aria-hidden /></span>
      <span className="dim">Loading feeds…</span>
    </div>
  );
}

export default function App() {
  const [prefs, setPrefs] = usePrefs();
  const night = useTheme(prefs.night);
  const [hh] = useHouseholdVM();
  const ready = useReady();
  const [settingsView, setSettingsView] = useState<'main' | 'import'>(() => (new URLSearchParams(location.search).get('tab') === 'import' ? 'import' : 'main'));
  const [setup, setSetup] = useState(() => hh.status === 'none' || !hh.me || readJoinFromUrl() !== null);
  const [tab, setTab] = useState<Tab>(initialTab);
  const [timerOpen, setTimerOpen] = useState(() => new URLSearchParams(location.search).has('timer'));
  const [sheet, setSheet] = useState<{ mode: SheetMode; draft: EntryDraft } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const active = useActiveFeedVM();
  const act = useActions();
  const lastOz = useRef(3);

  // Timer closes itself when the feed ends (here or on the other phone).
  useEffect(() => {
    if (!active) setTimerOpen(false);
  }, [active]);

  const clearToast = useCallback(() => setToast(null), []);
  const closeSheet = useCallback(() => setSheet(null), []);
  const fail = (e: unknown) => setToast(e instanceof Error ? e.message : 'Something went wrong');

  if (setup && !ready && hh.status === 'none') return <div className="app"><Loading /></div>;
  if (setup) return <div className="app"><SetupScreen onDone={() => { history.replaceState(null, '', location.pathname); setSetup(false); }} /></div>;

  const toggleNight = () => setPrefs({ night: night ? 'off' : 'on' });

  return (
    <div className="app">
      {timerOpen && active ? (
        <TimerScreen
          feed={active}
          disabled={!ready}
          onHide={() => setTimerOpen(false)}
          onSwitch={() => void act.switchSide().catch(fail)}
          onPause={() => void act.pause().catch(fail)}
          onResume={() => void act.resume().catch(fail)}
          onEnd={() => { const t = fmtClock(active.elapsedMs); void act.endFeed().then(() => setToast(`Feed saved · ${t}`), fail); }}
          onEndOther={(id) => void act.endOtherFeed(id).then(() => setToast('Their feed was ended and saved'), fail)}
          onDiscard={(id) => void act.discardFeed(id).then(() => setToast('Feed discarded'), fail)}
        />
      ) : !ready ? (
        <>
          <Loading />
          <TabBar tab={tab} onChange={setTab} />
        </>
      ) : (
        <>
          {tab === 'home' && (
            <HomeScreen
              units={prefs.units}
              night={night}
              active={active}
              onToggleNight={toggleNight}
              onStart={(s) => void act.startFeed(s).then(() => setTimerOpen(true), (e) => { if (e instanceof FeedAlreadyRunning) { setTimerOpen(true); setToast('A feed is already running'); } else fail(e); })}
              onBottle={() => setSheet({ mode: 'bottle', draft: newBottleDraft(lastOz.current) })}
              onOpenTimer={() => setTimerOpen(true)}
            />
          )}
          {tab === 'history' && (
            <HistoryScreen
              units={prefs.units}
              onEdit={(e) => setSheet({ mode: 'edit', draft: e.draft })}
              onAdd={() => setSheet({ mode: 'add', draft: newBreastDraft() })}
              onDelete={(id) => void act.deleteEntry(id).then(() => setToast('Feed deleted'), fail)}
              onOpenTimer={() => setTimerOpen(true)}
            />
          )}
          {tab === 'charts' && <ChartsScreen units={prefs.units} />}
          {tab === 'settings' && settingsView === 'main' && <SettingsScreen prefs={prefs} night={night} onPrefs={setPrefs} onLeft={() => setSetup(true)} onImport={() => setSettingsView('import')} />}
          {tab === 'settings' && settingsView === 'import' && <NaraImportScreen onBack={() => setSettingsView('main')} onViewHistory={() => { setSettingsView('main'); setTab('history'); }} />}
          <TabBar tab={tab} onChange={(t) => { setSettingsView('main'); setTab(t); }} />
        </>
      )}

      <EntrySheet
        open={!!sheet}
        mode={sheet?.mode ?? 'bottle'}
        initial={sheet?.draft ?? null}
        units={prefs.units}
        onClose={closeSheet}
        onSave={async (d, original) => {
          await act.saveDraft(d, original ?? undefined);
          if (d.kind === 'bottle') lastOz.current = d.amountOz;
          setToast(sheet?.mode === 'edit' ? 'Changes saved' : d.kind === 'bottle' ? 'Bottle saved' : 'Feed saved');
        }}
        onDelete={sheet?.draft.id ? () => setDel(sheet.draft.id!) : undefined}
      />
      {del && (
        <ConfirmDialog title="Delete this feed?" body="It’s removed on both phones." confirmLabel="Delete" danger
          onCancel={() => setDel(null)}
          onConfirm={() => { const id = del; setDel(null); setSheet(null); void act.deleteEntry(id).then(() => setToast('Feed deleted'), fail); }} />
      )}
      <Toast text={toast} onDone={clearToast} />
    </div>
  );
}
