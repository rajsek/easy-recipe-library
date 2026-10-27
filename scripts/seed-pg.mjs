#!/usr/bin/env node
/**
 * Seed a Neon/Postgres recipe DB from db/seed-export.json (full Sheet export).
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/seed-pg.mjs [path-to-export.json]
 *
 * Steps: applies db/schema.sql, then inserts every row, per tab, in Sheet
 * order. Idempotency: refuses to seed a non-empty videos table (pass --force
 * to append anyway). Requires: npm i (adds @neondatabase/serverless).
 */
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const TABS = {
  videos: ['video_id','title','channel','url','thumbnail_url','duration_s','views','category','diet_hint','yt_publish_date','date_first_added','date_last_checked','extraction_status'],
  recipes: ['recipe_name','video_url','channel','diet','meal_type','time_notes','ingredients','steps','source_note','verified','date_checked'],
  history: ['date','video_id','title','state','notes'],
  picks: ['date','filters','note','suggested_video_ids','chosen_video_id','suggested_titles'],
  rawextracts: ['video_id','title','channel_hint','yt_publish_date','description','transcript','extracted_at','parse_status'],
};

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const file = process.argv[2] || new URL('../db/seed-export.json', import.meta.url).pathname;
const force = process.argv.includes('--force');
const sql = neon(url);
const data = JSON.parse(readFileSync(file, 'utf8'));

console.log('applying db/schema.sql ...');
const schema = readFileSync(new URL('../db/schema.sql', import.meta.url), 'utf8');
for (const stmt of schema.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').split(';').map((s) => s.trim()).filter(Boolean)) {
  await sql.query(stmt);
}

const [{ n }] = await sql.query('SELECT count(*)::int AS n FROM videos');
if (n > 0 && !force) { console.error(`videos already has ${n} rows; aborting (use --force to append)`); process.exit(1); }

for (const [table, cols] of Object.entries(TABS)) {
  const grid = data[table] || [];
  const hdr = grid[0] || [];
  const rows = grid.slice(1);
  const idx = cols.map((c) => hdr.indexOf(c));
  let count = 0;
  const BATCH = 50; // multi-row INSERTs keep HTTP calls low (~90 for the videos table)
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const vals = [];
    const tuples = batch.map((r, bi) => {
      const cells = idx.map((hi, ci) => {
        vals.push(hi >= 0 && r[hi] != null ? String(r[hi]) : null);
        return '$' + (bi * cols.length + ci + 1);
      });
      return '(' + cells.join(', ') + ')';
    });
    await sql.query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, vals);
    count += batch.length;
    if (rows.length > 200) process.stdout.write(`\r${table}: ${count}/${rows.length}`);
  }
  console.log(`${table}: ${count} rows seeded`);
}
console.log('done.');
