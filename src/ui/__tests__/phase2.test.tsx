/** Phase-2 UI: ready gating, inline join errors, both-started banner (End/Discard), Nara import screen.
 *  Nara fixtures are SYNTHETIC (made-up caregivers, keys and times) — never the user's real export. */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { CoreProvider, type BreastFeed, type FeedCore } from '../../core';
import { gateActions, NOT_READY_MSG } from '../adapter';
import { joinOtherPhone } from '../demo';
import { testCore } from './helpers';

const renderApp = (core: FeedCore) => render(<CoreProvider core={core}><App /></CoreProvider>);
const setTab = (tab: string) => history.replaceState(null, '', `/?tab=${tab}`);

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });

describe('gateActions', () => {
  it('rejects calmly (without calling through) while blocked, passes through when ready', async () => {
    let blocked = true;
    const fn = vi.fn(async (x: number) => x * 2);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = gateActions(() => blocked, { fn });
    await expect(g.fn(2)).rejects.toThrow(NOT_READY_MSG);
    expect(fn).not.toHaveBeenCalled();
    blocked = false;
    await expect(g.fn(2)).resolves.toBe(4);
    warn.mockRestore();
  });
});

describe('join errors are shown inline', () => {
  it('a well-formed but unknown code → "Invite code not recognised"', async () => {
    const { core } = testCore();
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Join with code or link' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Household code or link' }), { target: { value: '0123456789ABCDEFGHJKMNPQRSTVWXYZ' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Karyn' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Join' })); });
    expect(await screen.findByRole('alert')).toHaveTextContent(/That invite code is not valid|Invite code not recognised/);
    expect(screen.getByTestId('setup')).toBeInTheDocument();
  });
});

describe('both phones started a feed', () => {
  it('shows "X also started a feed" with End (ends theirs, keeps mine running) and Discard', async () => {
    const a = testCore({ deviceId: 'phone-a' });
    await a.core.createHousehold('Samir');
    const b = await joinOtherPhone(a.core, a.server); // Karyn
    await b.startBreast('L', { startedAt: Date.now() - 5 * 60_000 });
    await b.syncNow();
    // Samir started offline a minute later (core allows it only when it hasn't seen Karyn's yet): import as running.
    const mine: BreastFeed = {
      id: crypto.randomUUID(), householdId: a.core.householdId!, createdAt: Date.now(), updatedAt: Date.now(), deleted: false,
      loggedBy: a.core.getSnapshot().me!, deviceId: 'phone-a', kind: 'breast', startedAt: Date.now() - 60_000, endedAt: null,
      segments: [{ side: 'R', startedAt: Date.now() - 60_000, endedAt: null }], pausedAt: null, status: 'running',
    };
    await a.core.importEntries([mine]);
    await a.core.syncNow();
    setTab('home');
    history.replaceState(null, '', '/?timer');
    renderApp(a.core);
    const banner = await screen.findByTestId('also-started');
    expect(banner).toHaveTextContent('Karyn also started a feed');
    await act(async () => { fireEvent.click(within(banner).getByRole('button', { name: 'End' })); });
    await waitFor(() => expect(screen.queryByTestId('also-started')).toBeNull());
    const theirs = a.core.getSnapshot().feeds.find((f) => f.kind === 'breast' && f.loggedBy.name === 'Karyn') as BreastFeed;
    expect(theirs.status).toBe('ended');
    expect(theirs.segments.every((s) => s.endedAt !== null)).toBe(true);
    expect(screen.getByTestId('timer')).toBeInTheDocument(); // mine still running
    b.dispose();
  });
});

// ---- synthetic Nara CSV ----
const HEADER = ['Type', 'Profile Name', 'Start Date/time', 'Start Date/time (Epoch)', 'Created By Caregiver', 'Last Updated By Caregiver', 'Note', 'Time Zone',
  '[Bottle Feed] Type', '[Bottle Feed] Breast Milk Volume', '[Bottle Feed] Breast Milk Volume Unit', '[Bottle Feed] Formula Name', '[Bottle Feed] Formula Volume',
  '[Bottle Feed] Formula Volume Unit', '[Bottle Feed] Volume', '[Bottle Feed] Volume Unit', '[Breastfeed] Begin Side', '[Breastfeed] End Side',
  '[Breastfeed] Left Duration (Seconds)', '[Breastfeed] Right Duration (Seconds)', '[Diaper] Type', '[Combo Feed] Begin Side', '[Combo Feed] End Side',
  '[Combo Feed] Left Duration (Seconds)', '[Combo Feed] Right Duration (Seconds)', '[Combo Feed] Type', '[Combo Feed] Breast Milk Volume',
  '[Combo Feed] Breast Milk Volume Unit', '[Combo Feed] Formula Volume', '[Combo Feed] Formula Volume Unit', '[Combo Feed] Volume', '[Combo Feed] Volume Unit',
  '_familyKey', '_profileKey', '_activityKey'];
type Row = Record<string, string | number>;
const csv = (rows: Row[]) => [HEADER.join(','), ...rows.map((r) => HEADER.map((c) => String(r[c] ?? '')).join(','))].join('\n') + '\n';
const T = Date.now() - 2 * 86_400_000;
const syntheticCsv = csv([
  { Type: 'Breastfeed', 'Start Date/time (Epoch)': Math.floor(T / 1000), 'Created By Caregiver': 'Alex', '[Breastfeed] Begin Side': 'LEFT', '[Breastfeed] End Side': 'RIGHT', '[Breastfeed] Left Duration (Seconds)': 600, '[Breastfeed] Right Duration (Seconds)': 300, _activityKey: 'syn-1' },
  { Type: 'Bottle Feed', 'Start Date/time (Epoch)': Math.floor((T + 3 * 3600_000) / 1000), 'Created By Caregiver': 'Blake', '[Bottle Feed] Type': 'Formula', '[Bottle Feed] Volume': 3, '[Bottle Feed] Volume Unit': 'FLOZ', _activityKey: 'syn-2' },
  { Type: 'Diaper', 'Start Date/time (Epoch)': Math.floor((T + 3600_000) / 1000), 'Created By Caregiver': 'Alex', '[Diaper] Type': 'Wet', _activityKey: 'syn-3' },
]);
const fileOf = (text: string) => { const f = new File([text], 'export.csv', { type: 'text/csv' }); if (!('text' in f)) Object.assign(f, { text: async () => text }); return f; };

describe('Import from Nara (Settings)', () => {
  it('preview → caregiver mapping → import → done; idempotent re-import; feeds land in History', async () => {
    const { core } = testCore();
    await core.createHousehold('Samir');
    setTab('settings');
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: /Import from Nara/ }));
    expect(screen.getByRole('heading', { name: 'Import from Nara' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose CSV file' })).toBeInTheDocument();

    const input = screen.getByLabelText('Nara CSV file') as HTMLInputElement;
    expect(input.accept).toContain('.csv');
    // Not a Nara file → calm inline error
    await act(async () => { fireEvent.change(input, { target: { files: [fileOf('a,b\n1,2\n')] } }); });
    expect(await screen.findByRole('alert')).toHaveTextContent(/doesn.t look like a Nara Baby export/);

    await act(async () => { fireEvent.change(input, { target: { files: [fileOf(syntheticCsv)] } }); });
    const preview = await screen.findByTestId('nara-preview');
    expect(preview).toHaveTextContent('2 feeds');
    expect(preview).toHaveTextContent(/Diaper 1/);
    expect(screen.getByText('Who is “Alex”?')).toBeInTheDocument();
    expect(screen.getByText('Who is “Blake”?')).toBeInTheDocument();
    // default mapping is "me"; map Blake → still me (only member) and import
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Import 2 feeds' })); });
    const done = await screen.findByTestId('nara-done');
    expect(done).toHaveTextContent(/Added\s*2/);
    expect(done).toHaveTextContent(/same file again is safe/);
    expect(core.getSnapshot().feeds.filter((f) => f.source === 'nara')).toHaveLength(2);

    // Re-import: nothing doubled
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    fireEvent.click(await screen.findByRole('button', { name: /Import from Nara/ }));
    await act(async () => { fireEvent.change(screen.getByLabelText('Nara CSV file'), { target: { files: [fileOf(syntheticCsv)] } }); });
    await act(async () => { fireEvent.click(await screen.findByRole('button', { name: 'Import 2 feeds' })); });
    expect(await screen.findByTestId('nara-done')).toHaveTextContent(/Already here\s*2/);
    expect(core.getSnapshot().feeds.filter((f) => f.source === 'nara')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: 'See history' }));
    expect(await screen.findByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(screen.getAllByText(/3 oz/).length).toBeGreaterThan(0);
  });
});
