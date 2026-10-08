import { useState } from 'react';
import { copyText, shareInvite } from '../ui/share';
import { IconCopy, IconShare } from './Icons';
import { QrCode } from './QrCode';

/** Household code (large, grouped), QR of the invite link, Share + Copy. */
export function InviteCard({ code, link, showQr = true }: { code: string; link: string; showQr?: boolean }) {
  const [msg, setMsg] = useState<string | null>(null);
  const groups = code.split('-');
  const half = Math.ceil(groups.length / 2);
  const flash = (m: string) => { setMsg(m); window.setTimeout(() => setMsg(null), 2200); };
  return (
    <div className="invite">
      <div className="code num" aria-label={`Household code ${code}`} data-testid="invite-code">
        <span>{groups.slice(0, half).join('-')}</span>
        <span>{groups.slice(half).join('-')}</span>
      </div>
      {showQr && <div className="qr-wrap"><QrCode text={link} size={184} /></div>}
      <div className="row2">
        <button type="button" className="btn btn-primary" onClick={async () => { const r = await shareInvite(link, code); if (r === 'copied') flash('Invite link copied'); }}>
          <IconShare /> Share invite
        </button>
        <button type="button" className="btn" onClick={async () => flash((await copyText(code)) === 'copied' ? 'Code copied' : 'Couldn’t copy')}>
          <IconCopy /> Copy code
        </button>
      </div>
      <div className="dim small center" role="status" aria-live="polite">{msg ?? (showQr ? 'Your partner can scan the QR, open the link, or type the code.' : 'Your partner can open the link or type the code.')}</div>
    </div>
  );
}
