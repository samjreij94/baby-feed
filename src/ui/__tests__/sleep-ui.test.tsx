import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../App';
import { CoreProvider, localDateKey } from '../../core';
import { seedHousehold } from '../demo';
import { fmtCountdown } from '../sleep/format';
import { testCore } from './helpers';

const renderApp = (core: ReturnType<typeof testCore>['core']) => render(<CoreProvider core={core}><App /></CoreProvider>);
const MIN = 60_000;

async function seeded() {
  const t = testCore();
  await t.core.createHousehold('Samir');
  await seedHousehold(t.core, t.server);
  return t;
}

async function openSleep() {
  fireEvent.click(screen.getByRole('button', { name: 'Sleep' }));
  return screen.findByTestId('sleep');
}

describe('Sleep tab', () => {
  beforeEach(() => localStorage.clear());

  it('opens Tonight, Plan and History without touching feeds or weights', async () => {
    const { core } = await seeded();
    const feeds = JSON.stringify(core.getSnapshot().feeds);
    const weights = JSON.stringify(core.getSnapshot().weights);
    renderApp(core);
    await openSleep();
    expect(screen.getByTestId('sleep-tonight')).toBeInTheDocument();
    expect(screen.getByTestId('sleep-night')).toHaveTextContent(/Night \d+/);
    expect(screen.getByRole('button', { name: 'Start bedtime / Put down' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'Plan' }));
    expect(await screen.findByTestId('sleep-plan')).toBeInTheDocument();
    expect(screen.getByLabelText('Plan start date')).toBeInTheDocument();
    expect(screen.getByLabelText('Morning cutoff')).toBeInTheDocument();
    const table = screen.getByTestId('sleep-intervals');
    expect(within(table).getByText(/N1/)).toBeInTheDocument();
    expect(screen.getByText(/Checks are brief/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'History' }));
    expect(await screen.findByTestId('sleep-history')).toHaveTextContent(/Nights will show up here/);

    expect(JSON.stringify(core.getSnapshot().feeds)).toBe(feeds);
    expect(JSON.stringify(core.getSnapshot().weights)).toBe(weights);
  });

  it('runs put down and a crying countdown from timerState; stopping resets the wait', async () => {
    const { core } = await seeded();
    renderApp(core);
    await openSleep();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start bedtime / Put down' })); });
    expect(await screen.findByText(/Put down at/)).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Crying' })); });
    const count = await screen.findByTestId('sleep-countdown');
    expect(count).toHaveTextContent('Check #1 in');
    expect(count.textContent).toMatch(/[23]:\d{2}/);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Stop crying' })); });
    expect(screen.queryByTestId('sleep-countdown')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Crying' })); });
    expect(await screen.findByTestId('sleep-countdown')).toHaveTextContent('Check #1 in');
    expect(screen.getByTestId('sleep-countdown').textContent).toMatch(/[23]:\d{2}/);
    expect(screen.queryByTestId('sleep-remote')).toBeNull();
  });

  it('reloads the countdown from timerState timestamps, not a tick counter', async () => {
    const t = testCore();
    await t.core.createHousehold('Samir');
    const now = t.core.now();
    await t.core.setSleepPlan({ startDate: localDateKey(now) });
    const session = await t.core.startSleepSession({ type: 'night', startedAt: now - 80_000, putDownAt: now - 80_000 });
    await t.core.addSleepEvent(session.id, 'cry_start', { at: now - 80_000 });

    renderApp(t.core);
    await openSleep();
    const again = await screen.findByTestId('sleep-countdown');
    expect(again).toHaveTextContent('Check #1 in');
    // 3 min − 80 s = 1:40, allow a second of hook lag.
    expect(again.textContent).toMatch(/1:3[89]|1:40|1:41/);
    expect(fmtCountdown(3 * MIN - 80_000)).toBe('1:40');
  });

  it('shows the go-in prompt when the wait is due, then check #2 after leaving', async () => {
    const t = testCore();
    await t.core.createHousehold('Samir');
    const now = t.core.now();
    await t.core.setSleepPlan({ startDate: localDateKey(now) });
    const session = await t.core.startSleepSession({ type: 'night', startedAt: now - 3 * MIN, putDownAt: now - 3 * MIN });
    await t.core.addSleepEvent(session.id, 'cry_start', { at: now - 3 * MIN });

    renderApp(t.core);
    await openSleep();
    expect(await screen.findByTestId('sleep-goin')).toHaveTextContent(/Go in: 1–2 min, lights off, pat\/shush/);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /I’m going in/ })); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Check done, I’ve left/ })); });
    const next = await screen.findByTestId('sleep-countdown');
    expect(next).toHaveTextContent('Check #2 in');
    expect(next.textContent).toMatch(/5:\d{2}/);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Asleep' })); });
    expect(await screen.findByTestId('sleep-asleep')).toHaveTextContent(/asleep/i);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Morning (end)' })); });
    expect(await screen.findByRole('button', { name: 'Start bedtime / Put down' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('radio', { name: 'History' }));
    const hist = await screen.findByTestId('sleep-history');
    expect(hist).toHaveTextContent('Night 1');
    expect(hist).toHaveTextContent(/asleep in 3 min/);
  });

  it('nap mode shows the 60 min cap', async () => {
    const t = testCore();
    await t.core.createHousehold('Samir');
    const first = renderApp(t.core);
    await openSleep();
    fireEvent.click(screen.getByRole('radio', { name: 'Nap' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Start nap' })); });
    expect(await screen.findByTestId('sleep-napcap')).toHaveTextContent(/Nap cap in \d+:\d{2}/);

    first.unmount();
    const now = t.core.now();
    const open = t.core.getSnapshot().sleepSessions.find((s) => s.endedAt == null);
    if (open) await t.core.endSleepSession(open.id);
    await t.core.startSleepSession({ type: 'nap', startedAt: now - 60 * MIN, putDownAt: now - 60 * MIN });
    renderApp(t.core);
    fireEvent.click(await screen.findByRole('button', { name: 'Sleep' }));
    expect(await screen.findByTestId('sleep-napcap')).toHaveTextContent(/Nap cap reached/);
  });

  it('keeps tap targets at the QC size (≥48px, hero ≥64px)', () => {
    const cssText = readFileSync(`${process.cwd()}/src/ui/styles/app.css`, 'utf8');
    const px = (re: RegExp) => Number(cssText.match(re)?.[1]);
    expect(px(/--tap: (\d+)px/)).toBeGreaterThanOrEqual(48);
    expect(px(/--tap-lg: (\d+)px/)).toBeGreaterThanOrEqual(56);
    expect(cssText).toMatch(/\.sleep-hero-btn \{ min-height: 64px;/);
    expect(cssText).toMatch(/\.sleep-grid-btn \{ min-height: var\(--tap-lg\);/);
    expect(cssText).toMatch(/\.sleep-int \{ min-height: var\(--tap\);/);
    expect(cssText).toMatch(/\.tabbar button \{[^}]*min-height: 48px/);
  });
});
