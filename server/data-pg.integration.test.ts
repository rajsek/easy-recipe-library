import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createPgStore, PG_TABS, buildInsert } from './data-pg.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function boot() {
  const db = new PGlite();
  const schema = readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  for (const stmt of schema.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  const client = { query: async (text: string, values?: any[]) => (await db.query(text, values)).rows };
  return { db, store: createPgStore('postgresql://unused', client) };
}

test('pg integration: schema + seed-style insert + readTab/appendRow round-trip', async () => {
  const { db, store } = await boot();

  // seed-style insert via buildInsert (same shape as scripts/seed-pg.mjs)
  const videoRow = ['v1', 'Paneer Butter Masala', 'HomeCookingShow', 'https://youtube.com/watch?v=v1', 'https://i.ytimg.com/vi/v1/mqdefault.jpg', '600', '1000', 'paneer', 'veg', '2026-10-01', '2026-10-26', '2026-10-27', 'extracted'];
  const q1 = buildInsert(PG_TABS.Videos, videoRow);
  await db.query(q1.text, q1.values);
  const videoRow2 = ['v2', 'Egg Curry', 'SomeChannel', 'https://youtube.com/watch?v=v2', '', '300', null, 'egg', 'non-veg', null, '2026-10-26', '2026-10-26', 'pending'];
  const q2 = buildInsert(PG_TABS.Videos, videoRow2);
  await db.query(q2.text, q2.values);

  const videos = await store.readTab('Videos');
  assert.equal(videos.length, 2);
  assert.equal(videos[0].video_id, 'v1'); // insertion order preserved
  assert.equal(videos[1].video_id, 'v2');
  assert.equal(videos[1].views, ''); // null -> ''
  assert.equal(videos[1].yt_publish_date, '');

  // appendRow round-trips through every tab the app writes
  await store.appendRow('History', ['2026-10-27', 'v1', 'Paneer Butter Masala', 'saved', 'app button']);
  await store.appendRow('Picks', ['2026-10-27', '{"diet":"Veg"}', '', 'v1,v2', 'v1', 'A | B']);
  await store.appendRow('Queue', ['qtest1', '2026-10-27T00:00:00Z', 'Veg', 'Dinner', 'quick paneer', 'pending', '', '']);
  await store.appendRow('Recipes', ['Paneer Butter Masala', 'https://youtube.com/watch?v=v1', 'HomeCookingShow', 'Veg', 'Dinner', '30 min', 'paneer 200g', 'cook', 'video description', 'yes', '2026-10-27']);
  await store.appendRow('RawExtracts', ['v1', 'title', 'HomeCookingShow', '2026-10-01', 'desc text', 'transcript', '2026-10-27', 'parsed']);

  const hist = await store.readTab('History');
  assert.equal(hist.length, 1);
  assert.equal(hist[0].state, 'saved');
  const queue = await store.readTab('Queue');
  assert.equal(queue[0].request_id, 'qtest1');
  assert.equal(queue[0].status, 'pending');

  // answer-queue write-back path (same SQL scripts/answer-queue.mjs runs)
  await db.query("UPDATE queue SET status='answered', answer=$2 WHERE request_id=$1", ['qtest1', 'try paneer 65']);
  const after = await store.readTab('Queue');
  assert.equal(after[0].status, 'answered');
  assert.equal(after[0].answer, 'try paneer 65');

  const recipes = await store.readTab('Recipes');
  assert.equal(recipes.length, 1);
  assert.equal(recipes[0].verified, 'yes');
  const raw = await store.readTab('RawExtracts');
  assert.equal(raw[0].parse_status, 'parsed');
});

test('pg integration: profile column round-trips and defaults to empty namespace', async () => {
  const { db, store } = await boot();
  await store.appendRow('History', ['2026-10-27', 'v1', 'Dish', 'saved', 'app button']); // no profile -> default ''
  await store.appendRow('History', ['2026-10-27', 'v2', 'Dish2', 'cooked', 'app button', 'amma']);
  const rows = await store.readTab('History');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].profile, '');
  assert.equal(rows[1].profile, 'amma');
  const [{ n }] = (await db.query("SELECT count(*)::int AS n FROM history WHERE profile = ''")).rows as any[];
  assert.equal(n, 1);
});

test('pg integration: seed idempotency guard data (count check) works on schema', async () => {
  const { db } = await boot();
  const [{ n }] = (await db.query('SELECT count(*)::int AS n FROM videos')).rows as any[];
  assert.equal(n, 0); // empty table -> seed would proceed
});
