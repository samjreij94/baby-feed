import { describe, expect, it } from 'vitest';
import { sha1, utf8, uuidV5 } from '../uuid';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

describe('sha1 / uuidV5', () => {
  it('matches SHA-1 test vectors', () => {
    expect(hex(sha1(utf8('')))).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(hex(sha1(utf8('abc')))).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(hex(sha1(utf8('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')))).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
    expect(hex(sha1(utf8('a'.repeat(1000))))).toBe('291e9a6c66994949b57ba5e650361e98fc36b1ba');
  });

  it('matches the RFC 4122 / Python uuid5 reference (DNS namespace, "python.org")', () => {
    expect(uuidV5('python.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('encodes non-ASCII names as UTF-8', () => {
    expect(utf8('é€😀')).toEqual([0xc3, 0xa9, 0xe2, 0x82, 0xac, 0xf0, 0x9f, 0x98, 0x80]);
    const a = uuidV5('café', '6ba7b810-9dad-11d1-80b4-00c04fd430c8');
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
