import { useState } from 'react';
import { InviteCard } from '../components/InviteCard';
import { IconDrop } from '../components/Icons';
import { NamePicker } from '../components/NamePicker';
import { isValidJoin, readJoinFromUrl, useHouseholdVM, useReady } from '../ui/adapter';

type Step = 'welcome' | 'create' | 'invite' | 'join';

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [hh, act] = useHouseholdVM();
  const urlCode = readJoinFromUrl();
  const [step, setStep] = useState<Step>(urlCode ? 'join' : hh.status === 'joined' ? 'invite' : 'welcome');
  const [name, setName] = useState('');
  const [baby, setBaby] = useState('');
  const [code, setCode] = useState(urlCode ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ready = useReady();

  const run = async (fn: () => Promise<void>, next?: Step) => {
    setBusy(true); setErr(null);
    try { await fn(); if (next) setStep(next); else onDone(); } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const nameOk = name.trim().length > 0;

  return (
    <div className="screen setup" data-testid="setup">
      <div className="setup-brand">
        <span className="brand-ic"><IconDrop /></span>
        <h1>Baby Feed</h1>
        <p className="dim">Track feeds together. Calm at 3 AM.</p>
      </div>

      {step === 'welcome' && (
        <div className="setup-actions">
          <button type="button" className="btn btn-primary btn-xl" onClick={() => setStep('create')}>Create household</button>
          <button type="button" className="btn btn-xl" onClick={() => setStep('join')}>Join with code or link</button>
          <p className="dim small center">One of you creates the household; the other joins with the code.</p>
        </div>
      )}

      {(step === 'create' || step === 'join') && (
        <form className="card stack-lg" onSubmit={(e) => {
          e.preventDefault();
          if (step === 'create') void run(() => act.create(name, baby.trim() || null), 'invite');
          else void run(() => act.join(code, name, baby.trim() || null));
        }}>
          <h2 className="form-title">{step === 'create' ? 'Create household' : 'Join household'}</h2>
          {step === 'join' && (
            <div className="field">
              <div className="caption" id="code-cap">Household code or link</div>
              <input className="input code-input num" aria-labelledby="code-cap" placeholder="XXXX-XXXX-…" autoCapitalize="characters" autoCorrect="off" spellCheck={false}
                value={code} onChange={(e) => setCode(e.target.value)} />
              {code && !isValidJoin(code) && <div className="hint">Codes are 32 letters and numbers. Paste the whole link or code.</div>}
            </div>
          )}
          <NamePicker caption="Your name" value={name} onChange={setName} />
          <div className="field">
            <div className="caption" id="baby-cap">Baby’s name <span className="dim">(optional)</span></div>
            <input className="input" aria-labelledby="baby-cap" value={baby} onChange={(e) => setBaby(e.target.value)} maxLength={24} autoComplete="off" />
          </div>
          {err && <div className="error" role="alert">{err}</div>}
          <button type="submit" className="btn btn-primary btn-lg" disabled={busy || !ready || !nameOk || (step === 'join' && !isValidJoin(code))}>
            {busy ? 'One moment…' : step === 'create' ? 'Create' : 'Join'}
          </button>
          <button type="button" className="btn btn-quiet" onClick={() => { setErr(null); setStep('welcome'); }}>Back</button>
        </form>
      )}

      {step === 'invite' && hh.code && hh.link && (
        <div className="card stack-lg">
          <h2 className="form-title">Invite your partner</h2>
          <p className="dim">On their iPhone, scan this code or open the shared link. Either phone can log feeds.</p>
          <InviteCard code={hh.code} link={hh.link} />
          <button type="button" className="btn btn-primary btn-lg" onClick={onDone}>Continue</button>
        </div>
      )}
    </div>
  );
}
