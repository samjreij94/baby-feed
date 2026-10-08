import { fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EntrySheet } from '../../components/EntrySheet';
import { Stepper } from '../../components/Stepper';

function Harness({ initial = 3 }: { initial?: number }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <Stepper caption="Amount" value={v} step={0.25} min={0.25} max={12} suffix="oz" onChange={setV} />
      <output data-testid="val">{v}</output>
    </>
  );
}

describe('Stepper (gym-app label-tap regression)', () => {
  it('tapping the caption does not change the value', () => {
    render(<Harness />);
    const caption = screen.getByTestId('stepper-caption');
    expect(caption.tagName).toBe('DIV');
    fireEvent.click(caption);
    fireEvent.pointerDown(caption);
    fireEvent.mouseUp(caption);
    fireEvent.click(caption);
    expect(screen.getByTestId('val')).toHaveTextContent('3');
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('3');
  });

  it('renders no <label> element anywhere in the stepper', () => {
    const { container } = render(<Harness />);
    expect(container.querySelectorAll('label')).toHaveLength(0);
    expect(container.querySelector('label button, label input')).toBeNull();
  });

  it('+ / − step by 0.25 oz and clamp at the minimum', () => {
    render(<Harness initial={0.5} />);
    fireEvent.click(screen.getByRole('button', { name: 'Increase Amount' }));
    expect(screen.getByTestId('val')).toHaveTextContent('0.75');
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Amount' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Amount' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease Amount' }));
    expect(screen.getByTestId('val')).toHaveTextContent('0.25');
    expect(screen.getByRole('button', { name: 'Decrease Amount' })).toBeDisabled();
  });

  it('typed values snap to 0.25 oz on blur', () => {
    render(<Harness />);
    const input = screen.getByRole('textbox', { name: 'Amount' });
    fireEvent.change(input, { target: { value: '4.3' } });
    fireEvent.blur(input);
    expect(screen.getByTestId('val')).toHaveTextContent('4.25');
  });

  it('bottle sheet: tapping every caption leaves amount, milk and time unchanged; no <label> in the sheet', async () => {
    const onSave = vi.fn(async (_d: unknown, _o: unknown) => {});
    const at = new Date(2026, 9, 8, 13, 5).getTime();
    render(<EntrySheet open mode="bottle" units="oz" initial={{ kind: 'bottle', at, amountOz: 3, milk: 'breast' }} onSave={onSave} onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelectorAll('label')).toHaveLength(0);
    for (const c of dialog.querySelectorAll('.caption')) fireEvent.click(c);
    expect(screen.getByRole('textbox', { name: 'Amount' })).toHaveValue('3');
    expect(screen.getByRole('radio', { name: 'Breast milk' })).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave.mock.calls[0]![0]).toEqual({ kind: 'bottle', at, amountOz: 3, milk: 'breast' });
  });

  it('stepper buttons and input are at least 48px (CSS contract)', () => {
    const css = readFileSync(`${process.cwd()}/src/ui/styles/app.css`, 'utf8');
    const px = (re: RegExp) => Number(re.exec(css)?.[1]);
    expect(px(/\.step-btn \{[^}]*width: (\d+)px/)).toBeGreaterThanOrEqual(48);
    expect(px(/\.step-btn \{[^}]*height: (\d+)px/)).toBeGreaterThanOrEqual(48);
    expect(px(/\.step-value input \{[^}]*height: (\d+)px/)).toBeGreaterThanOrEqual(48);
    expect(px(/--tap: (\d+)px/)).toBeGreaterThanOrEqual(48);
  });
});
