import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { CoreProvider, useNaraImport } from '../hooks';
import { FeedCore } from '../store';
import type { NaraParseOptions } from '../import/nara';
import type { BottleFeed } from '../types';

// The real parser lives in ../import/nara (separate worker); the hook contract is what's tested here.
vi.mock('../import/nara', () => ({
  parseNaraCsv: (text: string, opts: NaraParseOptions) => {
    if (text.startsWith('bad')) throw new Error('Not a Nara export');
    const who = opts.caregiverMap?.['Mom'] ?? opts.me!;
    const e: BottleFeed = {
      id: '33333333-3333-4333-8333-333333333333', householdId: opts.householdId, createdAt: 1, updatedAt: 1, deleted: false,
      loggedBy: who, deviceId: opts.deviceId, kind: 'bottle', at: 1_790_000_000_000, amountOz: 2, source: 'nara', externalId: 'k1',
    };
    return { preview: { rows: 1, feeds: 1, caregivers: ['Mom'] }, entries: [e] };
  },
}));

const file = (s: string) => ({ text: async () => s }) as File;

describe('useNaraImport', () => {
  it('parse → preview → confirm(caregiverMap) → result; errors surface', async () => {
    const core = new FeedCore({ storage: 'memory', mirror: false, autoSync: false });
    await core.setMe('Samir');
    const wrapper = ({ children }: { children: ReactNode }) => <CoreProvider core={core}>{children}</CoreProvider>;
    const { result } = renderHook(() => useNaraImport(), { wrapper });
    expect(result.current.status).toBe('idle');

    await act(() => result.current.parseFile(file('bad csv')));
    expect(result.current).toMatchObject({ status: 'error', error: 'Not a Nara export' });

    await act(() => result.current.parseFile(file('ok')));
    expect(result.current.status).toBe('ready');
    expect(result.current.preview).toMatchObject({ rows: 1, feeds: 1 });

    const karyn = { id: 'karyn-id', name: 'Karyn' };
    await act(() => result.current.confirm({ Mom: karyn }));
    await waitFor(() => expect(result.current.status).toBe('done'));
    expect(result.current.result).toEqual({ added: 1, skippedExisting: 0, skippedDeleted: 0, invalid: 0 });
    expect(core.getSnapshot().feeds[0]).toMatchObject({ source: 'nara', loggedBy: karyn });

    act(() => result.current.reset());
    expect(result.current.status).toBe('idle');
    core.dispose();
  });
});
