/** Baby name is core's synced household name: setup/settings write it, both phones read it, old local name migrates. */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../App';
import { CoreProvider, type FeedCore } from '../../core';
import { joinOtherPhone } from '../demo';
import { testCore } from './helpers';

const LEGACY_KEY = 'bf.ui.baby.v1';
const renderApp = (core: FeedCore) => render(<CoreProvider core={core}><App /></CoreProvider>);

beforeEach(() => { localStorage.clear(); history.replaceState(null, '', '/'); });

describe('baby name (synced household name)', () => {
  it('a name saved in Settings on one phone shows on the other phone’s Home after sync', async () => {
    const a = testCore({ deviceId: 'phone-a' });
    await a.core.createHousehold('Samir');
    const b = await joinOtherPhone(a.core, a.server);
    history.replaceState(null, '', '/?tab=settings');
    const view = renderApp(a.core);
    const field = await screen.findByRole('textbox', { name: 'Baby’s name' });
    fireEvent.change(field, { target: { value: 'Josephine' } });
    await act(async () => { fireEvent.blur(field); });
    await waitFor(() => expect(a.core.getSnapshot().babyName).toBe('Josephine'));
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull(); // nothing device-local any more
    await act(async () => { await a.core.syncNow(); await b.syncNow(); });
    view.unmount();
    history.replaceState(null, '', '/');
    renderApp(b);
    expect(await screen.findByRole('heading', { name: 'Josephine' })).toBeInTheDocument();
    b.dispose();
  });

  it('the name typed at setup (create) is stored in core and reaches a joining phone', async () => {
    const { core, server } = testCore();
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Create household' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Karyn' }));
    fireEvent.change(screen.getByRole('textbox', { name: /baby’s name/i }), { target: { value: 'Josephine' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Create' })); });
    await waitFor(() => expect(core.householdId).not.toBeNull());
    expect(core.getSnapshot().babyName).toBe('Josephine');
    const other = await joinOtherPhone(core, server);
    expect(other.getSnapshot().babyName).toBe('Josephine');
    other.dispose();
  });

  const joinViaSetup = async (code: string, baby: string) => {
    fireEvent.click(await screen.findByRole('button', { name: 'Join with code or link' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Household code or link' }), { target: { value: code } });
    fireEvent.click(screen.getByRole('radio', { name: 'Karyn' }));
    fireEvent.change(screen.getByRole('textbox', { name: /baby’s name/i }), { target: { value: baby } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Join' })); });
  };
  /** Join finished: pulled at least once and nothing left in the outbox. */
  const settled = (core: FeedCore) => waitFor(() => {
    const s = core.getSnapshot().sync;
    expect(s.lastSyncedAt).not.toBeNull();
    expect(s.pending).toBe(0);
    expect(s.state).toBe('idle');
  });

  it('a name typed while joining does NOT overwrite the household’s name (household wins)', async () => {
    const a = testCore({ deviceId: 'phone-a' });
    await a.core.createHousehold('Samir');
    await a.core.setBabyName('Josephine');
    await a.core.syncNow();
    const b = testCore({ deviceId: 'phone-b', server: a.server });
    renderApp(b.core);
    await joinViaSetup(a.core.inviteCode!, 'Jo');
    await settled(b.core);
    await act(async () => { await b.core.syncNow(); await a.core.syncNow(); });
    expect(b.core.getSnapshot().babyName).toBe('Josephine');
    expect(a.core.getSnapshot().babyName).toBe('Josephine');
    expect(await screen.findByRole('heading', { name: 'Josephine' })).toBeInTheDocument();
    b.core.dispose();
  });

  it('a name typed while joining applies when the household has none', async () => {
    const a = testCore({ deviceId: 'phone-a' });
    await a.core.createHousehold('Samir');
    const b = testCore({ deviceId: 'phone-b', server: a.server });
    renderApp(b.core);
    await joinViaSetup(a.core.inviteCode!, 'Josephine');
    await settled(b.core);
    expect(b.core.getSnapshot().babyName).toBe('Josephine');
    await act(async () => { await a.core.syncNow(); });
    expect(a.core.getSnapshot().babyName).toBe('Josephine');
    b.core.dispose();
  });

  it('migrates an old device-local name into core once (household had none), then drops the local copy', async () => {
    const a = testCore({ deviceId: 'phone-a' });
    await a.core.createHousehold('Samir');
    localStorage.setItem(LEGACY_KEY, 'Josephine');
    renderApp(a.core);
    // shown right away from the local copy, before any sync
    expect(await screen.findByRole('heading', { name: 'Josephine' })).toBeInTheDocument();
    expect(a.core.getSnapshot().babyName).toBe('');
    await act(async () => { await a.core.syncNow(); }); // waits for a pull so the other phone's name would win
    await waitFor(() => expect(a.core.getSnapshot().babyName).toBe('Josephine'));
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    await act(async () => { await a.core.syncNow(); });
    const b = await joinOtherPhone(a.core, a.server);
    expect(b.getSnapshot().babyName).toBe('Josephine');
    b.dispose();
  });

  it('a name the household already has wins over this phone’s old local one', async () => {
    const a = testCore({ deviceId: 'phone-a' });
    await a.core.createHousehold('Samir');
    const b = await joinOtherPhone(a.core, a.server);
    await b.setBabyName('Jo');
    await b.syncNow();
    localStorage.setItem(LEGACY_KEY, 'Josie');
    renderApp(a.core);
    await act(async () => { await a.core.syncNow(); });
    expect(await screen.findByRole('heading', { name: 'Jo' })).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(LEGACY_KEY)).toBeNull());
    expect(a.core.getSnapshot().babyName).toBe('Jo');
    b.dispose();
  });
});
