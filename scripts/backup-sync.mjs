#!/usr/bin/env node
/**
 * Read-only backup / verification of a household's sync data (pure pull: `changes: []`, nothing is written).
 *
 *   BABY_FEED_INVITE='ABCD-…' node scripts/backup-sync.mjs                  # write backups/sync-<ts>.json + print counts
 *   BABY_FEED_INVITE='…' node scripts/backup-sync.mjs --verify backups/sync-<before>.json
 *       # pull again and check every pre-existing entry is still present and byte-identical (new weight rows are fine)
 *
 * The invite code (household secret) is read from BABY_FEED_INVITE or --invite; it is never written to the backup.
 * The backup contains household data, so backups/ is git-ignored. Node >= 18 (global fetch).
 * Options: --api <url> (default https://baby-feed-sync.samjreij94.workers.dev), --out <dir> (default backups).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const api = (opt('--api') ?? process.env.VITE_API_BASE_URL ?? 'https://baby-feed-sync.samjreij94.workers.dev').replace(/\/+$/, '');
const outDir = resolve(opt('--out') ?? 'backups');
const verifyPath = opt('--verify');

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const raw = opt('--invite') ?? process.env.BABY_FEED_INVITE ?? '';
const m = /#join=([^&\s]+)/.exec(raw);
const secret = (m ? decodeURIComponent(m[1]) : raw).toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0').replace(/U/g, 'V');
if (secret.length !== 32 || [...secret].some((c) => !ALPHABET.includes(c))) {
  console.error('Need the household invite code or link: BABY_FEED_INVITE=… node scripts/backup-sync.mjs');
  process.exit(2);
}

async function pullAll() {
  const entries = [];
  let since = null;
  for (let page = 0; page < 10_000; page++) {
    const res = await fetch(`${api}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ since, changes: [], deviceId: 'backup-script' }),
    });
    if (!res.ok) throw new Error(`sync failed: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    entries.push(...body.changes);
    since = body.cursor;
    if (!body.hasMore) return { entries, cursor: since };
  }
  throw new Error('too many pages');
}

function count(entries) {
  const out = {};
  for (const e of entries) {
    const k = (out[e.kind] ??= { total: 0, live: 0, deleted: 0 });
    k.total++;
    e.deleted ? k.deleted++ : k.live++;
  }
  return out;
}
const show = (c) => Object.entries(c).map(([k, v]) => `  ${k.padEnd(8)} live ${String(v.live).padStart(5)}   deleted ${String(v.deleted).padStart(4)}   total ${v.total}`).join('\n') || '  (no entries)';

const { entries, cursor } = await pullAll();
const counts = count(entries);

if (verifyPath) {
  const before = JSON.parse(readFileSync(verifyPath, 'utf8'));
  const now = new Map(entries.map((e) => [e.id, JSON.stringify(e)]));
  const missing = [], changed = [];
  for (const e of before.entries) {
    const cur = now.get(e.id);
    if (cur === undefined) missing.push(e.id);
    else if (cur !== JSON.stringify(e)) changed.push(e.id);
  }
  console.log(`Before (${before.takenAt}):\n${show(before.counts)}\nAfter (now):\n${show(counts)}`);
  const added = entries.length - before.entries.length;
  console.log(`\nPre-existing entries: ${before.entries.length}; missing ${missing.length}; modified ${changed.length}; new rows since backup ${added}`);
  if (missing.length || changed.length) {
    console.error('MISMATCH (could be edits made on a phone since the backup; inspect):', { missing: missing.slice(0, 10), changed: changed.slice(0, 10) });
    process.exit(1);
  }
  console.log('OK: every entry from the backup is still present and identical.');
} else {
  mkdirSync(outDir, { recursive: true });
  const takenAt = new Date().toISOString();
  const file = resolve(outDir, `sync-${takenAt.replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ takenAt, api, cursor, counts, entries }, null, 2), { mode: 0o600 });
  console.log(`Backed up ${entries.length} entries to ${file}\n${show(counts)}`);
}
