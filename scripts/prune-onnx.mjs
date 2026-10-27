#!/usr/bin/env node
/**
 * Shrink Vercel Functions Storage: remove onnxruntime native binaries the
 * serverless function can never use. Vercel functions run linux/x64 CPU-only:
 * the darwin/win32/linux-arm64 builds and the CUDA provider library are dead
 * weight in every retained deployment. onnxruntime-node loads the CUDA
 * provider lazily; CPU inference (all-MiniLM-L6-v2 embeddings) works without
 * it. Local embeddings, semantic search and RAG are unchanged.
 */
import { rmSync, existsSync, statSync, readdirSync } from 'node:fs';
import path from 'node:path';

const base = path.resolve('node_modules/onnxruntime-node/bin/napi-v6');
const targets = [
  'darwin',
  'win32',
  'linux/arm64',
  'linux/x64/libonnxruntime_providers_cuda.so',
];

function sizeOf(p) {
  try {
    const s = statSync(p);
    if (s.isFile()) return s.size;
    if (s.isDirectory()) return readdirSync(p).reduce((n, f) => n + sizeOf(path.join(p, f)), 0);
  } catch {}
  return 0;
}

let freed = 0;
for (const t of targets) {
  const p = path.join(base, t);
  if (!existsSync(p)) { console.log('skip (absent):', t); continue; }
  freed += sizeOf(p);
  rmSync(p, { recursive: true, force: true });
  console.log('pruned:', t);
}
console.log('freed ~' + (freed / 1048576).toFixed(0) + ' MB of unused native binaries');
