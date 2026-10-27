#!/usr/bin/env node
/**
 * Add newly extracted recipe rows to the Neon/Postgres recipe DB (pg mode).
 * This is the post-cutover writer: extraction results go to the database,
 * NOT the Google Sheet (the Sheet is frozen as the pre-cutover snapshot).
 *
 * Usage:
 *   DATABASE_URL="postgresql://..." node scripts/extract-add.mjs <rows.json> [--dry-run]
 *
 * rows.json shape (Sheet tab names, Sheet column names - same mapping as
 * scripts/seed-pg.mjs):
 *   { "videos": [...], "recipes": [...], "rawextracts": [...] }
 * Any of the three arrays may be omitted.
 *
 * Idempotent: a row whose natural key already exists is SKIPPED, never
 * duplicated - safe to re-run after a partial failure.
 *   videos:      video_id, else url
 *   recipes:     video_url + recipe_name
 *   rawextracts: video_id
 */
import { readFileSync } from 'node:fs';
import { neon } from '@neondatabase/serverless';

const COLS = {
  videos: ['video_id','title','channel','url','thumbnail_url','duration_s','views','category','diet_hint','yt_publish_date','date_first_added','date_last_checked','extraction_status'],
  recipes: ['recipe_name','video_url','channel','diet','meal_type','time_notes','ingredients','steps','source_note','verified','date_checked'],
  rawextracts: ['video_id','title','channel_hint','yt_publish_date','description','transcript','extracted_at','parse_status'],
};

const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL required'); process.exit(1); }
const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!file) { console.error('usage: node scripts/extract-add.mjs <rows.json> [--dry-run]'); process.exit(1); }
const rows = JSON.parse(readFileSync(file, 'utf8'));
const sql = neon(url);

const report = {};
for (const [table, cols] of Object.entries(COLS)) {
  const list = Array.isArray(rows[table]) ? rows[table] : [];
  let inserted = 0, skipped = 0;
  for (const r of list) {
    const vals = cols.map(c => r[c] == null ? null : String(r[c]));
    let exists;
    if (table === 'videos') {
      const vid = r.video_id || null, u = r.url || null;
      exists = (await sql.query('SELECT 1 FROM videos WHERE (video_id IS NOT NULL AND video_id=$1) OR (url IS NOT NULL AND url=$2) LIMIT 1', [vid, u])).length > 0;
    } else if (table === 'recipes') {
      exists = (await sql.query('SELECT 1 FROM recipes WHERE video_url=$1 AND recipe_name=$2 LIMIT 1', [r.video_url || '', r.recipe_name || ''])).length > 0;
    } else {
      exists = (await sql.query('SELECT 1 FROM rawextracts WHERE video_id=$1 LIMIT 1', [r.video_id || ''])).length > 0;
    }
    if (exists) { skipped++; continue; }
    if (!dryRun) {
      const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
      await sql.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`, vals);
    }
    inserted++;
  }
  report[table] = { received: list.length, inserted, skipped };
}
console.log(JSON.stringify({ dryRun, ...report }));
