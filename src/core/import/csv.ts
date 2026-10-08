/**
 * Minimal RFC 4180 CSV parser (pure, sync, no dependencies).
 * - Fields separated by `,`; records by CRLF, LF or a lone CR.
 * - Quoted fields may contain commas, line breaks and escaped quotes (`""`).
 * - A leading UTF-8 BOM is dropped. A trailing line break does not create an empty record.
 * - Lenient: text after a closing quote is appended to the field; an unterminated quote runs to end of input.
 * Blank lines come back as `['']` — callers decide whether to ignore them.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (i >= n) return rows;
  let row: string[] = [];
  for (;;) {
    let field: string;
    if (text.charCodeAt(i) === 34 /* " */) {
      let buf = '';
      let j = i + 1;
      for (;;) {
        const q = text.indexOf('"', j);
        if (q === -1) {
          buf += text.slice(j);
          i = n;
          break;
        }
        if (text.charCodeAt(q + 1) === 34) {
          buf += text.slice(j, q + 1);
          j = q + 2;
          continue;
        }
        buf += text.slice(j, q);
        i = q + 1;
        break;
      }
      const k = scanUnquoted(text, i);
      if (k > i) buf += text.slice(i, k);
      i = k;
      field = buf;
    } else {
      const k = scanUnquoted(text, i);
      field = text.slice(i, k);
      i = k;
    }
    row.push(field);
    if (i >= n) {
      rows.push(row);
      break;
    }
    const c = text.charCodeAt(i);
    if (c === 44 /* , */) {
      i++;
      continue;
    }
    // record separator: CRLF, LF or CR
    i += c === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
    rows.push(row);
    row = [];
    if (i >= n) break;
  }
  return rows;
}

/** Index of the next `,`, LF or CR at/after `from` (or text.length). */
function scanUnquoted(text: string, from: number): number {
  const n = text.length;
  let k = from;
  while (k < n) {
    const c = text.charCodeAt(k);
    if (c === 44 || c === 10 || c === 13) break;
    k++;
  }
  return k;
}
