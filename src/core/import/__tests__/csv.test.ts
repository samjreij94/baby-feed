import { describe, expect, it } from 'vitest';
import { parseCsv } from '../csv';

describe('parseCsv (RFC 4180)', () => {
  it('parses simple LF records and ignores a trailing newline', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF and lone CR record separators', () => {
    expect(parseCsv('a,b\r\n1,2\r\n3,4\r5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ]);
  });

  it('drops a leading UTF-8 BOM', () => {
    const rows = parseCsv('\uFEFFType,Note\nX,y\n');
    expect(rows[0]).toEqual(['Type', 'Note']);
  });

  it('keeps commas, line breaks (LF and CRLF) and escaped quotes inside quoted fields', () => {
    const rows = parseCsv('id,note,n\r\n1,"line one\nline two, with comma",9\r\n2,"say ""hi""\r\nagain",8\r\n');
    expect(rows).toEqual([
      ['id', 'note', 'n'],
      ['1', 'line one\nline two, with comma', '9'],
      ['2', 'say "hi"\r\nagain', '8'],
    ]);
  });

  it('handles empty fields, a trailing comma and empty quoted fields', () => {
    expect(parseCsv('a,,c,\n"",x,"",\n')).toEqual([
      ['a', '', 'c', ''],
      ['', 'x', '', ''],
    ]);
  });

  it('returns blank lines as [""] and [] for empty input', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\uFEFF')).toEqual([]);
    expect(parseCsv('a\n\nb\n')).toEqual([['a'], [''], ['b']]);
  });

  it('is lenient with an unterminated quote and text after a closing quote', () => {
    expect(parseCsv('a,"open\nstill open')).toEqual([['a', 'open\nstill open']]);
    expect(parseCsv('"ab"cd,e')).toEqual([['abcd', 'e']]);
  });
});
