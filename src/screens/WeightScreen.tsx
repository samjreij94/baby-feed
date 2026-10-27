import { useState } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { GrowthChart } from '../components/GrowthChart';
import { IconPlus, IconTrash } from '../components/Icons';
import { PersonChip } from '../components/PersonChip';
import { Segmented } from '../components/Segmented';
import { formatWeight, ordinal, useWeightVM, WHO_SOURCE } from '../ui/adapter';
import { fmtDay, fmtTime } from '../ui/format';
import type { WeightDraft, WeightRowVM, WeightUnit, WhoSex } from '../ui/types';

const UNIT_OPTS = [{ value: 'lb', label: 'lb / oz' }, { value: 'kg', label: 'kg' }] as const;
const SEX_OPTS = [{ value: 'girls', label: 'Girls' }, { value: 'boys', label: 'Boys' }] as const;
const pct = (p: number | null) => (p === null ? '—' : ordinal(p));

export function WeightScreen({ unit, onUnit, sex, onSex, onAdd, onEdit, onDelete }: {
  unit: WeightUnit; onUnit: (u: WeightUnit) => void; sex: WhoSex; onSex: (s: WhoSex) => void; onAdd: () => void; onEdit: (d: WeightDraft) => void; onDelete: (id: string) => void;
}) {
  const vm = useWeightVM(sex);
  const [del, setDel] = useState<WeightRowVM | null>(null);
  const latest = vm.rows[0];
  const name = vm.babyName ?? 'Baby';
  const gain = vm.gainG === null ? null : `${vm.gainG >= 0 ? '+' : '−'}${formatWeight(Math.abs(vm.gainG), unit)}`;
  const summary = `${name}'s weight by age, 0 to 24 months, against WHO weight-for-age percentile lines for ${sex} (3rd, 15th, 50th, 85th, 97th).`
    + (latest ? ` ${vm.points.length} logged. Latest ${formatWeight(latest.grams, unit)} at ${latest.ageLabel}${latest.percentile !== null ? `, about the ${ordinal(latest.percentile)} percentile` : ''}.` : ' No weights logged yet.');
  return (
    <div className="screen" data-testid="weight">
      <header className="top">
        <h1>Weight</h1>
        <button type="button" className="btn btn-sm icon-text" onClick={onAdd}><IconPlus /> Add</button>
      </header>
      <Segmented label="Weight units" value={unit} options={UNIT_OPTS} onChange={onUnit} />

      <div className="stats">
        <div className="stat"><b className="num">{latest ? formatWeight(latest.grams, unit) : '—'}</b><span>{latest ? `latest · ${fmtDay(latest.at)}` : 'latest'}</span></div>
        <div className="stat"><b className="num">{latest ? pct(latest.percentile) : '—'}</b><span>percentile (est., WHO {sex})</span></div>
        <div className="stat"><b className="num">{gain ?? '—'}</b><span>since previous</span></div>
        <div className="stat"><b className="num">{latest ? latest.ageLabel : '—'}</b><span>age at latest</span></div>
      </div>

      <section className="card chart-card">
        <h2>Weight by age <span className="dim unit">· {unit === 'kg' ? 'kg' : 'lb'}, 0–24 months</span></h2>
        <div className="legend wlegend">
          <span><i className="sw sw-me" />{name}</span>
          <span><i className="sw sw-who" />WHO {sex} percentiles</span>
        </div>
        <Segmented label="WHO standard" value={sex} options={SEX_OPTS} onChange={onSex} />
        <GrowthChart unit={unit} sex={sex} points={vm.points} summary={summary} />
        {vm.rows.length === 0 && <div className="dim small">Add {name}’s first weight to see her on the curves.</div>}
      </section>

      {vm.rows.length === 0 ? (
        <div className="card empty">No weights yet. Tap Add after a weigh-in; it shows up on both phones.</div>
      ) : (
        <section aria-label="Logged weights">
          <h2 className="day-head"><span>Logged weights</span><span className="dim num">{vm.rows.length}</span></h2>
          <ul className="rows">
            {vm.rows.map((r) => (
              <li key={r.id} className="h-row">
                <button type="button" className="h-main" onClick={() => onEdit(r.draft)} aria-label={`${formatWeight(r.grams, unit)}, ${fmtDay(r.at)}, age ${r.ageLabel}, by ${r.by.name}. Edit`}>
                  <span className="kind-ic kind-weight" aria-hidden>{unit === 'kg' ? 'kg' : 'lb'}</span>
                  <span className="h-text">
                    <span className="h-title num">{formatWeight(r.grams, unit)}</span>
                    <span className="h-detail h-wrap dim">{r.percentile === null ? r.ageLabel : `${r.ageLabel} · ≈ ${ordinal(r.percentile)} percentile (est.)`}</span>
                  </span>
                  <span className="h-when">
                    <span className="num">{fmtDay(r.at)}</span>
                    <span className="dim num">{fmtTime(r.at)}</span>
                  </span>
                </button>
                <PersonChip p={r.by} size="sm" />
                <button type="button" className="trash" aria-label={`Delete weight ${formatWeight(r.grams, unit)} on ${fmtDay(r.at)}`} onClick={() => setDel(r)}>
                  <IconTrash />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card source-card" aria-label="Data source">
        <h2>About the curves</h2>
        <p className="dim small">
          Percentile lines: {WHO_SOURCE.name}. {WHO_SOURCE.note}{' '}
          <a href={WHO_SOURCE.url} target="_blank" rel="noopener noreferrer">who.int/tools/child-growth-standards</a>
        </p>
        <p className="dim small">Percentiles next to logged weights are estimated from WHO’s published LMS values for the selected sex (girls by default, since that’s who this is for). This is a tracker, not medical advice; talk to your pediatrician about growth.</p>
      </section>

      {del && (
        <ConfirmDialog
          title="Delete this weight?"
          body={`${formatWeight(del.grams, unit)} on ${fmtDay(del.at)}. It’s removed on both phones.`}
          confirmLabel="Delete"
          danger
          onCancel={() => setDel(null)}
          onConfirm={() => { onDelete(del.id); setDel(null); }}
        />
      )}
    </div>
  );
}
