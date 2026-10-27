#!/usr/bin/env node
/**
 * Answer one queued ask-request in the pg backend (the app polls /api/ask/:id).
 * Usage: DATABASE_URL="postgresql://..." node scripts/answer-queue.mjs <request_id> "answer text"
 */
import { neon } from '@neondatabase/serverless';
const [id, ...rest] = process.argv.slice(2);
const answer = rest.join(' ').trim();
if (!process.env.DATABASE_URL || !id || !answer) {
  console.error('usage: DATABASE_URL=... node scripts/answer-queue.mjs <request_id> "answer"');
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);
const res = await sql.query("UPDATE queue SET status='answered', answer=$2 WHERE request_id=$1 RETURNING request_id", [id, answer]);
if (!res.length) { console.error('no queue row with request_id ' + id); process.exit(1); }
console.log('answered ' + id);
