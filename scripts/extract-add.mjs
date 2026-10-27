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
let statusFlipped = 0;
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
    if (exists) { skipped++; }
    else {
      if (!dryRun) {
        const ph = cols.map((_, i) => '$' + (i + 1)).join(',');
        await sql.query(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${ph})`, vals);
      }
      inserted++;
    }
    // Status parity (Sheet-era behavior): a rawextract parsed into a recipe
    // flips the video to parsed-to-recipe. Runs on insert AND on skip so a
    // rerun after a partial failure still converges; the UPDATE itself is
    // idempotent. Only when a recipes row verifiably exists for the video -
    // conflict-hold or unparsed rows never flip. Unknown rows untouched.
    if (table === 'rawextracts' && r.parse_status === 'parsed-to-recipe' && r.video_id && !dryRun) {
      const hasCard = (await sql.query('SELECT 1 FROM recipes WHERE strpos(video_url, $1) > 0 LIMIT 1', [r.video_id])).length > 0;
      if (hasCard) {
        const u = await sql.query("UPDATE videos SET extraction_status='parsed-to-recipe', date_last_checked=$2 WHERE video_id=$1 AND extraction_status IS DISTINCT FROM 'parsed-to-recipe' RETURNING video_id", [r.video_id, r.extracted_at || new Date().toISOString().slice(0,10)]);
        statusFlipped += u.length;
      }
    }
  }
  report[table] = { received: list.length, inserted, skipped };
  if (table === 'rawextracts') report[table].statusFlipped = statusFlipped;
}
console.log(JSON.stringify({ dryRun, ...report }));
