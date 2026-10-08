import { useEffect, useRef, useState } from 'react';
import { IconCheck, IconChevronLeft, IconFile } from '../components/Icons';
import { PersonChip } from '../components/PersonChip';
import { useNaraImportVM } from '../ui/adapter';
import { fmtOzNum, plural } from '../ui/format';
import type { NaraPreviewVM } from '../ui/types';

const fmtN = (n: number) => n.toLocaleString('en-US');
const fmtHours = (h: number) => (h >= 10 ? Math.round(h).toString() : h.toFixed(1));
const fmtDate = (ms: number) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function Preview({ p }: { p: NaraPreviewVM }) {
  return (
    <div className="card stack-lg" data-testid="nara-preview">
      <div>
        <div className="eyebrow">Ready to import</div>
        <div className="nara-big"><span className="num">{fmtN(p.feedsToImport)}</span> {p.feedsToImport === 1 ? 'feed' : 'feeds'}</div>
        <div className="dim">{p.from !== null && p.to !== null ? `${fmtDate(p.from)} – ${fmtDate(p.to)}` : 'No dates found'}</div>
      </div>
      <div className="stats nara-stats">
        <div className="stat"><div className="nara-val num">{fmtN(p.imported.breast)}</div><div className="caption">Breast</div></div>
        <div className="stat"><div className="nara-val num">{fmtN(p.imported.bottle)}</div><div className="caption">Bottle</div></div>
        {p.imported.combo > 0 && <div className="stat"><div className="nara-val num">{fmtN(p.imported.combo)}</div><div className="caption">Breast + bottle</div></div>}
      </div>
      <div className="stats nara-stats">
        <div className="stat"><div className="nara-val num">{fmtHours(p.leftHours)}<span className="suffix"> h</span></div><div className="caption">Left side</div></div>
        <div className="stat"><div className="nara-val num">{fmtHours(p.rightHours)}<span className="suffix"> h</span></div><div className="caption">Right side</div></div>
        <div className="stat"><div className="nara-val num">{p.bottleOz >= 100 ? fmtN(Math.round(p.bottleOz)) : fmtOzNum(p.bottleOz)}<span className="suffix"> oz</span></div><div className="caption">Bottles</div></div>
      </div>
      {p.skipped.length > 0 && (
        <div className="nara-skipped">
          <div className="caption">Not imported (this app tracks feeds only)</div>
          <div className="dim small">{p.skipped.map((s) => `${s.label} ${fmtN(s.count)}`).join(' · ')}</div>
        </div>
      )}
      {p.warnings.length > 0 && (
        <details className="nara-warn">
          <summary className="dim small">{plural(p.warnings.length, 'note', 'notes')} about this file</summary>
          <ul className="dim small">{p.warnings.slice(0, 20).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      <div className="dim small">From {fmtN(p.totalRows)} rows in the file.</div>
    </div>
  );
}

export function NaraImportScreen({ onBack, onViewHistory }: { onBack: () => void; onViewHistory: () => void }) {
  const vm = useNaraImportVM();
  const fileRef = useRef<HTMLInputElement>(null);
  const [picked, setMap] = useState<Record<string, string>>({});
  const [localError, setLocalError] = useState<string | null>(null);
  const p = vm.preview;

  // Caregiver mapping: what the user picked, else the default (same name → that member, else me).
  const map: Record<string, string> = {};
  for (const c of p?.caregivers ?? []) { const id = picked[c.name] ?? c.suggestedId; if (id) map[c.name] = id; }

  // Leaving the screen clears a half-finished import (reset is stable).
  const reset = vm.reset;
  useEffect(() => () => reset(), [reset]);

  const pick = () => fileRef.current?.click();
  const onFile = (f: File | undefined) => {
    setLocalError(null);
    if (!f) return;
    void vm.parseFile(f).catch((e: unknown) => setLocalError(e instanceof Error ? e.message : 'Could not read that file'));
  };
  const confirm = () => {
    setLocalError(null);
    void vm.confirm(map).catch((e: unknown) => setLocalError(e instanceof Error ? e.message : 'Import failed'));
  };
  const error = localError ?? (vm.status === 'error' ? vm.error : null);
  const busy = vm.status === 'parsing' || vm.status === 'importing';
  const unmapped = p?.caregivers.some((c) => !map[c.name]) ?? false;

  return (
    <div className="screen nara" data-testid="nara-import">
      <header className="top top-back">
        <button type="button" className="back-btn" onClick={onBack}><IconChevronLeft width={22} height={22} aria-hidden />Settings</button>
        <h1>Import from Nara</h1>
      </header>

      <input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" aria-label="Nara CSV file" tabIndex={-1}
        onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ''; }} />

      {vm.status === 'done' && vm.result ? (
        <div className="card stack-lg" data-testid="nara-done">
          <div className="row nara-done-head"><span className="done-ic"><IconCheck width={22} height={22} aria-hidden /></span><h2 className="form-title">Import finished</h2></div>
          <div className="rows nara-rows">
            <div className="row"><span className="grow">Added</span><span className="num nara-count">{fmtN(vm.result.added)}</span></div>
            <div className="row"><span className="grow">Already here</span><span className="num nara-count">{fmtN(vm.result.skippedExisting)}</span></div>
            <div className="row"><span className="grow">Previously deleted, left out</span><span className="num nara-count">{fmtN(vm.result.skippedDeleted)}</span></div>
            <div className="row"><span className="grow">Unreadable rows</span><span className="num nara-count">{fmtN(vm.result.invalid)}</span></div>
          </div>
          <p className="dim small">Imported feeds sync to both phones. Importing the same file again is safe — feeds that are already here are skipped, nothing is doubled.</p>
          <button type="button" className="btn btn-primary btn-lg btn-block" onClick={onViewHistory}>See history</button>
          <button type="button" className="btn btn-quiet btn-block" onClick={onBack}>Done</button>
        </div>
      ) : p && (vm.status === 'ready' || vm.status === 'importing') ? (
        <>
          <Preview p={p} />
          {p.caregivers.length > 0 && vm.members.length > 0 && (
            <>
              <h2 className="section">Who logged these?</h2>
              <div className="card stack-lg">
                {p.caregivers.map((c) => (
                  <div key={c.name} className="field">
                    <div className="caption" id={`cg-${c.name}`}>Who is “{c.name}”?</div>
                    <div className="choice-row" role="radiogroup" aria-labelledby={`cg-${c.name}`}>
                      {vm.members.map((m) => (
                        <button key={m.id} type="button" role="radio" aria-checked={map[c.name] === m.id} className="choice"
                          onClick={() => setMap((x) => ({ ...x, [c.name]: m.id }))}>
                          <PersonChip p={m} size="sm" />{m.name}{m.isMe ? ' (you)' : ''}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="nara-actions">
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy || unmapped || p.feedsToImport === 0} onClick={confirm}>
              {vm.status === 'importing' ? 'Importing…' : `Import ${fmtN(p.feedsToImport)} ${p.feedsToImport === 1 ? 'feed' : 'feeds'}`}
            </button>
            <button type="button" className="btn btn-quiet btn-block" disabled={busy} onClick={() => { vm.reset(); setLocalError(null); }}>Choose a different file</button>
          </div>
        </>
      ) : (
        <>
          <div className="card stack-lg">
            <div className="row nara-intro"><span className="kind-ic"><IconFile width={22} height={22} aria-hidden /></span>
              <div className="grow">
                <div className="h-title">Nara Baby CSV</div>
                <div className="dim small">In Nara: Settings → Export data → CSV. Save it to Files, then choose it here.</div>
              </div>
            </div>
            <ul className="dim small nara-notes">
              <li>Breastfeeds and bottles come across with their times, sides and amounts.</li>
              <li>Sleep, diapers and other activities are left out.</li>
              <li>Nothing is changed until you confirm.</li>
            </ul>
          </div>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="thumb-zone">
            <button type="button" className="btn btn-primary btn-lg btn-block" disabled={busy} onClick={pick}>
              {vm.status === 'parsing' ? 'Reading file…' : 'Choose CSV file'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
