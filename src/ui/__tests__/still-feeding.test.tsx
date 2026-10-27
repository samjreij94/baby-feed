import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { CoreProvider } from '../../core';
import { StillFeedingPrompt } from '../../components/StillFeedingPrompt';
import { seedHousehold } from '../demo';
import { MIN, testCore } from './helpers';

describe('StillFeedingPrompt (15-min check-in)', () => {
  beforeEach(() => localStorage.clear());

  it('appears at 15 min, Keep going snoozes until the next 15, Stop & save ends', () => {
    const onStop = vi.fn();
    const ui = (ms: number, running = true) => <StillFeedingPrompt feedId="f1" running={running} elapsedMs={ms} onStop={onStop} />;
    const { rerender } = render(ui(14 * MIN));
    expect(screen.queryByTestId('still-feeding')).toBeNull();
    rerender(ui(15 * MIN));
    expect(screen.getByRole('alertdialog', { name: 'Still feeding?' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
    expect(screen.queryByTestId('still-feeding')).toBeNull();
    rerender(ui(29 * MIN));
    expect(screen.queryByTestId('still-feeding')).toBeNull();
    rerender(ui(30 * MIN));
    expect(screen.getByTestId('still-feeding')).toBeInTheDocument();
    rerender(ui(31 * MIN, false)); // paused: hidden
    expect(screen.queryByTestId('still-feeding')).toBeNull();
    rerender(ui(31 * MIN));
    fireEvent.click(screen.getByRole('button', { name: /Stop & save/ }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('remembers Keep going across a reload of the same feed', () => {
    const a = render(<StillFeedingPrompt feedId="f2" running elapsedMs={16 * MIN} onStop={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));
    a.unmount();
    render(<StillFeedingPrompt feedId="f2" running elapsedMs={17 * MIN} onStop={() => undefined} />);
    expect(screen.queryByTestId('still-feeding')).toBeNull();
  });
});

describe('Started earlier? in the app', () => {
  beforeEach(() => localStorage.clear());

  it('start a backdated feed from Home, then edit the start on the running timer; no instant check-in', async () => {
    const t = testCore();
    await t.core.createHousehold('Samir');
    await seedHousehold(t.core, t.server);
    render(<CoreProvider core={t.core}><App /></CoreProvider>);
    fireEvent.click(await screen.findByTestId('started-earlier'));
    expect(await screen.findByText('Start now instead')).toBeInTheDocument();
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: /Start Left side/ })); });
    const feed = t.core.getSnapshot().feeds.find((x) => x.kind === 'breast' && x.status !== 'ended') as import('../../core').BreastFeed | undefined;
    expect(feed).toBeTruthy();
    expect(feed!.startedAt).toBeLessThanOrEqual(Date.now());
    fireEvent.click(await screen.findByTestId('edit-start'));
    const d = new Date(Date.now() - 20 * MIN);
    const pad = (n: number) => String(n).padStart(2, '0');
    fireEvent.change(await screen.findByLabelText('Started at'), { target: { value: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}` } });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Save start time' })); });
    expect(await screen.findByText('Start time updated')).toBeInTheDocument();
    const moved = t.core.getSnapshot().feeds.find((x) => x.kind === 'breast' && x.status !== 'ended') as import('../../core').BreastFeed;
    expect(Date.now() - moved.startedAt).toBeGreaterThanOrEqual(19 * MIN);
    expect(screen.queryByTestId('still-feeding')).toBeNull(); // adjusting the start doesn't trigger an instant check-in
  });
});
