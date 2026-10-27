import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '../../App';
import { CoreProvider, lbOzToGrams } from '../../core';
import { seedHousehold } from '../demo';
import { testCore } from './helpers';

const renderApp = (core: ReturnType<typeof testCore>['core']) => render(<CoreProvider core={core}><App /></CoreProvider>);
const day = 86_400_000;

async function seeded() {
  const t = testCore();
  await t.core.createHousehold('Samir');
  await seedHousehold(t.core, t.server);
  return t;
}

describe('Weight tab', () => {
  beforeEach(() => localStorage.clear());

  it('empty state still draws the WHO curves with citation and disclaimer', async () => {
    const { core } = await seeded();
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Weight' }));
    expect(await screen.findByText(/No weights yet/)).toBeInTheDocument();
    for (const p of [3, 15, 50, 85, 97]) expect(screen.getByTestId(`who-p${p}`).querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(screen.queryAllByTestId('weight-dot')).toHaveLength(0);
    const link = screen.getByRole('link', { name: /who\.int\/tools\/child-growth-standards/ });
    expect(link).toHaveAttribute('href', 'https://www.who.int/tools/child-growth-standards/standards/weight-for-age');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText(/not medical advice/)).toBeInTheDocument();
  });

  it('add via sheet (lb/oz), see it on the chart + list with an estimated percentile; feeds untouched', async () => {
    const { core } = await seeded();
    renderApp(core);
    const feedsBefore = JSON.stringify(core.getSnapshot().feeds);
    fireEvent.click(await screen.findByRole('button', { name: 'Weight' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: 'Increase Pounds' })); // 7 -> 8
    fireEvent.click(screen.getByRole('button', { name: 'Increase Ounces' })); // 0.1 oz
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save' })); });
    await screen.findByText('Weight saved');
    expect(core.getSnapshot().weights.map((w) => w.grams)).toEqual([lbOzToGrams(8, 0.1)]);
    expect(await screen.findAllByTestId('weight-dot')).toHaveLength(1);
    const list = screen.getByRole('region', { name: 'Logged weights' });
    expect(within(list).getByText('8 lb 0.1 oz')).toBeInTheDocument();
    expect(within(list).getByText(/percentile \(est\.\)/)).toBeInTheDocument();
    expect(JSON.stringify(core.getSnapshot().feeds)).toBe(feedsBefore);
  });

  it('kg unit switch changes display only; edit and delete (with confirm) go through core', async () => {
    const { core } = await seeded();
    await core.addWeight({ grams: 3289, at: Date.now() - 20 * day });
    await core.addWeight({ grams: 4500, at: Date.now() - 2 * day });
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Weight' }));
    expect(await screen.findAllByTestId('weight-dot')).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('radio', { name: 'kg' })[0]!);
    const list = screen.getByRole('region', { name: 'Logged weights' });
    expect(within(list).getByText('4.50 kg')).toBeInTheDocument();
    expect(within(list).getByText('3.29 kg')).toBeInTheDocument();
    expect(core.getSnapshot().weights.map((w) => w.grams)).toEqual([4500, 3289]); // stored units unchanged

    fireEvent.click(within(list).getByRole('button', { name: /^4\.50 kg.*Edit$/ }));
    const inc = screen.getByRole('button', { name: 'Increase Weight' });
    fireEvent.click(inc);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); });
    expect(core.getSnapshot().weights[0]!.grams).toBe(4510);
    expect(core.getSnapshot().weights).toHaveLength(2);

    fireEvent.click(screen.getAllByRole('button', { name: /^Delete weight/ })[0]!);
    expect(screen.getByRole('alertdialog', { name: 'Delete this weight?' })).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    await screen.findByText('Weight deleted');
    expect(core.getSnapshot().weights.map((w) => w.grams)).toEqual([3289]);
  });

  it('edit sheet can delete', async () => {
    const { core } = await seeded();
    await core.addWeight({ grams: 3300, at: Date.now() - day });
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Weight' }));
    fireEvent.click(await screen.findByRole('button', { name: /Edit$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete this weight' }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Delete' })); });
    await screen.findByText('Weight deleted');
    expect(core.getSnapshot().weights).toHaveLength(0);
  });

  it('girls/boys toggle: defaults to girls, swaps the curves, citation and percentile estimate, and persists', async () => {
    const { core } = await seeded();
    await core.addWeight({ grams: 7000, at: Date.now() - day });
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Weight' }));
    await screen.findAllByTestId('weight-dot');
    const chart = () => screen.getByTestId('growth-chart');
    const median = () => screen.getByTestId('who-p50').querySelector('path')!.getAttribute('d');
    const list = () => screen.getByRole('region', { name: 'Logged weights' });
    const pctText = () => within(list()).getByText(/\d(st|nd|rd|th) percentile/).textContent;

    expect(screen.getByRole('radio', { name: 'Girls' })).toBeChecked();
    expect(chart()).toHaveAttribute('data-sex', 'girls');
    expect(screen.getByText(/WHO girls percentiles/)).toBeInTheDocument();
    const girlsMedian = median();
    const girlsPct = pctText();

    fireEvent.click(screen.getByRole('radio', { name: 'Boys' }));
    expect(chart()).toHaveAttribute('data-sex', 'boys');
    expect(screen.getByText(/WHO boys percentiles/)).toBeInTheDocument();
    expect(median()).not.toBe(girlsMedian);
    expect(pctText()).not.toBe(girlsPct);
    expect(localStorage.getItem('bf.ui.whoSex.v1')).toBe('boys');
    expect(core.getSnapshot().weights.map((w) => w.grams)).toEqual([7000]); // display only; data untouched

    fireEvent.click(screen.getByRole('radio', { name: 'Girls' }));
    expect(median()).toBe(girlsMedian);
    expect(pctText()).toBe(girlsPct);
    expect(localStorage.getItem('bf.ui.whoSex.v1')).toBe('girls');
  });

  it('remembers boys across a reload', async () => {
    localStorage.setItem('bf.ui.whoSex.v1', 'boys');
    const { core } = await seeded();
    renderApp(core);
    fireEvent.click(await screen.findByRole('button', { name: 'Weight' }));
    await screen.findByTestId('growth-chart');
    expect(screen.getByTestId('growth-chart')).toHaveAttribute('data-sex', 'boys');
    expect(screen.getByRole('radio', { name: 'Boys' })).toBeChecked();
  });
});
