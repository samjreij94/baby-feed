import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from './App';
import { CoreProvider } from './core';
import { seedHousehold } from './ui/demo';
import { testCore } from './ui/__tests__/helpers';

const renderApp = (core: ReturnType<typeof testCore>['core']) => render(<CoreProvider core={core}><App /></CoreProvider>);

async function seeded(name = 'Samir') {
  const t = testCore();
  await t.core.createHousehold(name);
  await seedHousehold(t.core, t.server);
  return t;
}

describe('App on the real core', () => {
  beforeEach(() => localStorage.clear());

  it('first run: calm loading state until core is ready, then Setup with Create / Join', async () => {
    renderApp(testCore().core);
    expect(screen.getByTestId('loading')).toHaveTextContent('Loading feeds…');
    expect(await screen.findByRole('button', { name: 'Create household' })).toBeInTheDocument();
    expect(screen.queryByTestId('loading')).toBeNull();
    expect(screen.getByRole('button', { name: 'Join with code or link' })).toBeInTheDocument();
  });

  it('create household → invite code → home; starting Right opens the timer', async () => {
    const { core } = testCore();
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Create household' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Karyn' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Baby/ }), { target: { value: 'Noor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByTestId('invite-code')).toHaveTextContent(/[0-9A-Z]{4}-/);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Noor' })).toBeInTheDocument();
    expect(screen.getByText('No feeds yet')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start Right side/ }));
    expect(await screen.findByTestId('timer')).toBeInTheDocument();
    expect(screen.getByText('Right side')).toBeInTheDocument();
    expect(screen.queryByText(/started this feed/)).toBeNull(); // own feed → no banner
    expect(core.getSnapshot().feeds[0]!.loggedBy.name).toBe('Karyn');
  });

  it('home shows last fed / suggested side; tab bar reaches History, Charts and Settings', async () => {
    const { core } = await seeded();
    renderApp(core);
    expect(await screen.findByText('Last fed')).toBeInTheDocument();
    expect(screen.getByText('Next suggested')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));
    expect(await screen.findByText('Today')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Delete / }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Charts' }));
    expect(await screen.findByText('Nursing time per day')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByRole('radiogroup', { name: 'Night mode' })).toBeInTheDocument();
  });

  it('bottle sheet saves through core.addBottle', async () => {
    const { core } = await seeded();
    renderApp(core);
    const before = core.getSnapshot().feeds.length;
    fireEvent.click(await screen.findByRole('button', { name: 'Bottle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase Amount' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Formula' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await screen.findByText('Bottle saved');
    const f = core.getSnapshot().feeds.find((x) => x.kind === 'bottle' && x.loggedBy.name === 'Samir' && x.createdAt > Date.now() - 60_000);
    expect(core.getSnapshot().feeds.length).toBe(before + 1);
    expect(f).toMatchObject({ amountOz: 3.25, milk: 'formula' });
  });

  it('delete asks for confirmation, then tombstones through core', async () => {
    const { core } = await seeded();
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'History' }));
    const before = core.getSnapshot().feeds.length;
    fireEvent.click(screen.getAllByRole('button', { name: /^Delete / })[0]!);
    expect(screen.getByRole('alertdialog', { name: 'Delete this feed?' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    await screen.findByText('Feed deleted');
    expect(core.getSnapshot().feeds.length).toBe(before - 1);
  });
});
