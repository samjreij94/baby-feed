/** Invite code = household auth secret: 160 random bits as 32 Crockford base32 chars (SPEC §4). */
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 32;

export function generateInviteCode(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  let bits = 0;
  let acc = 0;
  let out = '';
  for (const x of b) {
    acc = (acc << 8) | x;
    bits += 8;
    while (bits >= 5) {
      out += CODE_ALPHABET[(acc >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acc &= (1 << bits) - 1;
  }
  return out;
}

/** Uppercase, drop spaces/dashes, map Crockford look-alikes (I/L→1, O→0, U→V). */
export function normalizeInviteCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function isValidInviteCode(code: string): boolean {
  return code.length === CODE_LENGTH && [...code].every((c) => CODE_ALPHABET.includes(c));
}

/** 'ABCD-EFGH-…' (groups of 4) for display. */
export function formatInviteCode(code: string): string {
  return code.match(/.{1,4}/g)?.join('-') ?? code;
}

export function inviteLink(appUrl: string, code: string): string {
  return `${appUrl.split('#')[0]}#join=${code}`;
}

/** Accepts a full link, a '#join=…' hash, or a raw/grouped code. Returns the normalized code or null. */
export function parseInvite(codeOrLink: string): string | null {
  const m = /#join=([^&\s]+)/.exec(codeOrLink);
  const code = normalizeInviteCode(m ? decodeURIComponent(m[1]!) : codeOrLink);
  return isValidInviteCode(code) ? code : null;
}

/** Invite code from location.hash (on app open via an invite link), else null. */
export function readInviteFromLocation(loc: Pick<Location, 'hash'> = location): string | null {
  return loc.hash.includes('join=') ? parseInvite(loc.hash) : null;
}
