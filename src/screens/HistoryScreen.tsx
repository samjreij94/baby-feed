import { useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconBottle, IconPlus, IconTrash } from '../components/Icons';
import { PersonChip } from '../components/PersonChip';
import { useHistoryVM } from '../ui/adapter';
import { fmtTime } from '../ui/format';
import type { HistoryEntryVM, Units } from '../ui/types';

const PAGE_DAYS = 10;

export function HistoryScreen({ units, onEdit, onAdd, onDelete, onOpenTimer }: {
  units: Units; onEdit: (e: HistoryEntryVM) => void; onAdd: () => void; onDelete: (id: string) => void; onOpenTimer: () => void;
}) {
  const days = useHistoryVM(units);
  const [shown, setShown] = useState(PAGE_DAYS);
  const [del, setDel] = useState<HistoryEntryVM | null>(null);
  return (
    <div className="screen" data-testid="history">
      <header className="top">
        <h1>History</h1>
        <button type="button" className="btn btn-sm icon-text" onClick={onAdd}><IconPlus /> Add</button>
      </header>
      {days.length === 0 && <div className="card empty">No feeds yet. Feeds you or your partner log show up here.</div>}
      {days.slice(0, shown).map((d) => (
        <section key={d.key} className="day" aria-label={d.label}>
          <h2 className="day-head"><span>{d.label}</span><span className="dim num">{d.summary}</span></h2>
          <ul className="rows">
            {d.entries.map((e) => (
              <li key={e.id} className="h-row">
                <button type="button" className="h-main" onClick={() => (e.running ? onOpenTimer() : onEdit(e))} aria-label={`${e.title}, ${e.detail}, ${fmtTime(e.at)}, by ${e.by.name}. ${e.running ? 'Open timer' : 'Edit'}`}>
                  <span className={`kind-ic ${e.kind === 'bottle' ? 'kind-bottle' : e.sides.length > 1 ? `both first-${e.sides[0]}` : `side-${e.side ?? 'L'}`}`} aria-hidden>
                    {e.kind === 'bottle' ? <IconBottle /> : e.sides.length > 1 ? e.sides.slice(0, 2).map((s) => <i key={s}>{s}</i>) : e.side}
                  </span>
                  <span className="h-text">
                    <span className="h-title">{e.title}</span>
                    <span className="h-detail dim">{e.detail}</span>
                  </span>
                  <span className="h-when">
                    <span className="num">{fmtTime(e.at)}</span>
                    <span className="dim num">{e.duration}</span>
                  </span>
                </button>
                <PersonChip p={e.by} size="sm" />
                <button type="button" className="trash" aria-label={`Delete ${e.title} at ${fmtTime(e.at)}`} onClick={() => setDel(e)}>
                  <IconTrash />
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {shown < days.length && (
        <button type="button" className="btn btn-block" onClick={() => setShown((n) => n + PAGE_DAYS)}>Show older days</button>
      )}
      {del && (
        <ConfirmDialog
          title="Delete this feed?"
          body={`${del.title}${del.kind === 'bottle' ? ` (${del.detail})` : ''} at ${fmtTime(del.at)}. It’s removed on both phones.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDel(null)}
          onConfirm={() => { onDelete(del.id); setDel(null); }}
        />
      )}
    </div>
  );
}
