process.env.TRANSFORMERS_CACHE = '/tmp/tf-cache';
import { neon } from '@neondatabase/serverless';
// @ts-ignore
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const url = readFileSync('/home/sandbox/.vault/recipe-library-neon-db-url-712552/password', 'utf8').trim();
const sql = neon(url);
const { loadSemantic, embed, SEMANTIC_MODEL, SEMANTIC_MODEL_REVISION } = await import('../server/semantic.ts');

const rows = await sql`SELECT video_id, title, channel, category, diet_hint, extraction_status FROM videos ORDER BY seq`;
console.log('videos:', rows.length);
await loadSemantic();

const texts = rows.map((r: any) => String(r.title || ''));
const vecs: number[][] = [];
const B = 256;
for (let i = 0; i < texts.length; i += B) {
  const part = await embed(texts.slice(i, i + B));
  if (!part) throw new Error('embed batch failed at ' + i);
  vecs.push(...part);
  if ((i / B) % 4 === 0) console.log('embedded', Math.min(i + B, texts.length), '/', texts.length);
}
if (vecs.length !== rows.length) throw new Error('embed count mismatch: ' + vecs.length);

const dim = vecs[0].length;
const q = new Int8Array(rows.length * dim);
for (let i = 0; i < rows.length; i++) {
  const v = vecs[i];
  if (v.length !== dim) throw new Error('dim mismatch at ' + i);
  for (let j = 0; j < dim; j++) q[i * dim + j] = Math.max(-127, Math.min(127, Math.round(v[j] * 127)));
}
const libHash = createHash('sha256').update(JSON.stringify(rows.map((r: any) => r.video_id))).digest('hex').slice(0, 12);
const out = {
  model: SEMANTIC_MODEL, revision: SEMANTIC_MODEL_REVISION, dim,
  quantization: 'int8/127', count: rows.length, library: libHash,
  generated: new Date().toISOString().slice(0, 10),
  videos: rows.map((r: any) => [r.video_id, r.title, r.channel, r.category, r.diet_hint, r.extraction_status]),
  vectors_b64_i8: Buffer.from(q.buffer).toString('base64'),
};
writeFileSync('/tmp/demo-embeddings-full.json', JSON.stringify(out));
console.log('wrote /tmp/demo-embeddings-full.json count=', rows.length, 'dim=', dim, 'lib=', libHash);
process.exit(0);
