import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** WCAG 2.1 relative-luminance contrast for two #rrggbb (or #rgb) colors. */
export function contrastRatio(a: string, b: string): number {
  const L1 = luminance(a);
  const L2 = luminance(b);
  const hi = Math.max(L1, L2);
  const lo = Math.min(L1, L2);
  return (hi + 0.05) / (lo + 0.05);
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function rgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`bad color: ${hex}`);
  return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)];
}

function tokensIn(css: string, selector: string): Record<string, string> {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, ' ');
  const re = /([^{}]+)\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  let body: string | null = null;
  while ((m = re.exec(stripped))) {
    const prelude = m[1]!.trim().replace(/\s+/g, ' ');
    if (prelude === selector) body = m[2]!;
  }
  if (body == null) throw new Error(`no rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const chunk of body.split(';')) {
    const bit = chunk.trim();
    if (!bit.startsWith('--')) continue;
    const colon = bit.indexOf(':');
    if (colon < 0) continue;
    const name = bit.slice(0, colon).trim();
    const raw = bit.slice(colon + 1).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    const hex = raw.match(/#([0-9a-fA-F]{3,8})\b/);
    if (hex) out[name] = '#' + (hex[1]!.length === 3 ? hex[1]!.split('').map((c) => c + c).join('') : hex[1]);
  }
  return out;
}

function merge(...parts: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...parts);
}

const PAIRS: [string, string, string][] = [
  ['text on bg', '--text', '--bg'],
  ['text on surface', '--text', '--surface'],
  ['text on surface-2', '--text', '--surface-2'],
  ['text on surface-3', '--text', '--surface-3'],
  ['text-dim on bg', '--text-dim', '--bg'],
  ['text-dim on surface', '--text-dim', '--surface'],
  ['text-dim on surface-2', '--text-dim', '--surface-2'],
  ['text-dim on surface-3', '--text-dim', '--surface-3'],
  ['on-accent on accent (primary btn)', '--on-accent', '--accent'],
  ['on-accent on sleep (Stop crying)', '--on-accent', '--sleep'],
  ['sleep-ink on sleep-soft (go-in)', '--sleep-ink', '--sleep-soft'],
  ['sleep-ink on amber-soft (cry off / plan row)', '--sleep-ink', '--sleep-amber-soft'],
  ['countdown amber on surface', '--sleep-amber', '--surface'],
  ['countdown amber on bg', '--sleep-amber', '--bg'],
  ['danger on danger-soft', '--danger', '--danger-soft'],
  ['accent on surface (quiet btn / Cancel)', '--accent', '--surface'],
  ['accent on bg', '--accent', '--bg'],
];

describe('Sleep theme contrast (WCAG AA 4.5:1)', () => {
  const css = readFileSync(`${process.cwd()}/src/ui/styles/app.css`, 'utf8');
  const day = tokensIn(css, ":root, [data-theme='day']");
  const night = tokensIn(css, "[data-theme='night']");
  const sleepDay = tokensIn(css, '.sleep-screen');
  const sleepNight = tokensIn(css, "[data-theme='night'] .sleep-screen");
  const dim = tokensIn(css, '.sleep-screen.is-dim');

  const modes: Record<string, Record<string, string>> = {
    day: merge(day, sleepDay),
    'day+dim': merge(day, sleepDay, dim),
    night: merge(night, sleepNight),
    'night+dim': merge(night, sleepNight, dim),
  };

  for (const [mode, tokens] of Object.entries(modes)) {
    it(`${mode}: key text/background pairs are at least 4.5:1`, () => {
      const failures: string[] = [];
      const report: string[] = [];
      for (const [label, fgName, bgName] of PAIRS) {
        const fg = tokens[fgName];
        const bg = tokens[bgName];
        if (!fg || !bg) {
          failures.push(`${label}: missing ${!fg ? fgName : bgName}`);
          continue;
        }
        const ratio = contrastRatio(fg, bg);
        report.push(`${ratio.toFixed(2)}:1  ${label}  ${fg} on ${bg}`);
        if (ratio + 1e-9 < 4.5) failures.push(`${label}: ${ratio.toFixed(2)}:1 (${fg} on ${bg})`);
      }
      expect(failures, failures.join('; ') || 'ok').toEqual([]);
    });
  }

  it('dim re-applies color and background on .sleep-screen so tokens resolve there', () => {
    expect(css).toMatch(/\.sleep-screen\s*\{[^}]*\bcolor:\s*var\(--text\)/);
    expect(css).toMatch(/\.sleep-screen\s*\{[^}]*\bbackground-color:\s*var\(--bg\)/);
    expect(css).toMatch(/button, input, select, textarea \{ font: inherit; color: inherit; \}/);
  });
});
