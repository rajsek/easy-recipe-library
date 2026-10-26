/**
 * Local semantic layer: meaning-aware retrieval and answer caching.
 *
 * - Embeddings run LOCALLY (transformers.js + all-MiniLM-L6-v2, both
 *   Apache-2.0). No question, recipe or history text ever leaves for
 *   embeddings. The one outbound contact is the model file download from
 *   huggingface.co on a cold cache (metadata only).
 * - The model revision is PINNED (no moving 'main'). Model version is part
 *   of every cache key, so a model change never silently reuses answers.
 * - Load is BOUNDED: SEMANTIC_LOAD_TIMEOUT_MS (default 20s), SEMANTIC=off
 *   disables. Any failure returns an honest 'unavailable' - callers fall
 *   back to the existing deterministic path and must NOT claim semantic
 *   behavior in that state.
 * - Semantics RANK and CACHE only. Hard constraints (verified-only, diet,
 *   meal, exclusions, food words, no-repeat) are applied by the
 *   deterministic layer BEFORE anything here runs; embeddings can never
 *   widen the allowed pool.
 */
import { createHash } from 'node:crypto';

export const SEMANTIC_MODEL = 'Xenova/all-MiniLM-L6-v2';
export const SEMANTIC_MODEL_REVISION = '751bff37182d3f1213fa05d7196b954e230abad9';
export const SEMANTIC_VERSION = SEMANTIC_MODEL + '@' + SEMANTIC_MODEL_REVISION.slice(0, 12);

export type EmbedFn = (texts: string[]) => Promise<number[][]>;

export interface SemanticState {
  available: boolean;
  version: string;
  reason?: string;
}

let embedFn: EmbedFn | null = null;
let loadState: SemanticState = { available: false, version: SEMANTIC_VERSION, reason: 'not attempted' };
let loadPromise: Promise<SemanticState> | null = null;

/** Bounded, pinned, once-per-instance model load. Never throws. */
export function loadSemantic(): Promise<SemanticState> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    if (String(process.env.SEMANTIC || '').toLowerCase() === 'off') {
      loadState = { available: false, version: SEMANTIC_VERSION, reason: 'disabled by SEMANTIC=off' };
      return loadState;
    }
    const timeoutMs = Number(process.env.SEMANTIC_LOAD_TIMEOUT_MS || 20000);
    try {
      const load = (async () => {
        const { pipeline, env } = await import('@huggingface/transformers');
        // Vercel's package dir is read-only; /tmp is the writable cache. The
        // download is from huggingface.co only (no auth) and bounded by the
        // load timeout; a cold instance honestly reports load time.
        if (process.env.TRANSFORMERS_CACHE) (env as any).cacheDir = process.env.TRANSFORMERS_CACHE;
        else if (process.env.VERCEL) (env as any).cacheDir = '/tmp/transformers-cache';
        const extractor: any = await pipeline('feature-extraction', SEMANTIC_MODEL, {
          dtype: 'q8',
          revision: SEMANTIC_MODEL_REVISION,
        });
        return async (texts: string[]): Promise<number[][]> => {
          const out = await extractor(texts, { pooling: 'mean', normalize: true });
          const rows: number[][] = [];
          for (let i = 0; i < texts.length; i++) rows.push(Array.from(out[i].data as Float32Array));
          return rows;
        };
      })();
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => rej(new Error('load timeout ' + timeoutMs + 'ms')), timeoutMs);
      });
      embedFn = await Promise.race([load, timeout]);
      clearTimeout(timer!);
      loadState = { available: true, version: SEMANTIC_VERSION };
    } catch (e: any) {
      embedFn = null;
      loadState = { available: false, version: SEMANTIC_VERSION, reason: String(e?.message || e) };
    }
    return loadState;
  })();
  return loadPromise;
}

export function semanticStatus(): SemanticState {
  return loadState;
}

/** Test hook: fully reset load state so a fresh loadSemantic() runs. */
export function _resetLoadStateForTests() {
  embedFn = null;
  loadPromise = null;
  loadState = { available: false, version: SEMANTIC_VERSION, reason: 'not attempted' };
}

/** Test hook: inject a fake embed function, bypassing the model. */
export function _setEmbedFnForTests(fn: EmbedFn | null, available = true) {
  embedFn = fn;
  loadState = fn ? { available, version: SEMANTIC_VERSION } : { available: false, version: SEMANTIC_VERSION, reason: 'test reset' };
  // When reset to null, block a real model load inside the test process.
  loadPromise = fn ? null : Promise.resolve(loadState);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** Embed texts; null when the model is unavailable (callers fall back). */
export async function embed(texts: string[]): Promise<number[][] | null> {
  if (!embedFn) await loadSemantic();
  if (!embedFn) return null;
  try {
    return await embedFn(texts);
  } catch {
    return null;
  }
}

export function cardText(r: { recipe_name: string; meal_type?: string; ingredients?: string }): string {
  return r.recipe_name + '. ' + (r.meal_type || '') + '. ' + String(r.ingredients || '').slice(0, 300);
}

/**
 * Re-rank an ALREADY hard-filtered candidate pool by meaning. Returns null
 * when embeddings are unavailable - never a fake "semantic" order.
 */
export async function semanticRank<T extends { recipe_name: string; meal_type?: string; ingredients?: string }>(
  query: string, candidates: T[], topN: number
): Promise<T[] | null> {
  if (candidates.length <= topN) return candidates;
  const vecs = await embed([query, ...candidates.map(cardText)]);
  if (!vecs) return null;
  const q = vecs[0];
  const scored = candidates.map((c, i) => ({ c, s: cosine(q, vecs[i + 1]) }));
  scored.sort((a, b) => b.s - a.s);
  return scored.slice(0, topN).map((x) => x.c);
}

// ---------- semantic answer cache ----------
// Similarity alone cannot prove "same question" (negation, amounts and
// ingredient contrasts fool embeddings), so a cache hit ALSO requires an
// identical constraint signature: diet, meal, exclusions, food words,
//   history/no-repeat state, library version, model version and intent.
export interface CacheKeyParts {
  diet: string;
  meal: string;
  exclusions: string[];
  foodWords: string[];
  excludedHash: string;   // current no-repeat set
  libraryVersion: string; // corpus snapshot version / content hash
  intent: string;         // 'answer' | 'more' etc. - 'more' never caches
}

export function constraintSignature(k: CacheKeyParts): string {
  const norm = (s: string) => s.trim().toLowerCase();
  const raw = [
    norm(k.diet), norm(k.meal),
    [...k.exclusions].map(norm).sort().join(','),
    [...k.foodWords].map(norm).sort().join(','),
    k.excludedHash, k.libraryVersion, k.intent, SEMANTIC_VERSION,
  ].join('|');
  return createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

interface CacheEntry {
  sig: string;
  qVec: number[];
  question: string;
  answer: unknown;
  at: number;
}

const CACHE_MAX = 50;
const CACHE_TTL_MS = 30 * 60 * 1000;
// High bar on purpose: a near-identical phrasing of the SAME request, not a
// merely related one. Anything below regenerates (a wasted call beats a
// wrong reused answer).
const CACHE_COSINE_MIN = 0.93;

export class SemanticCache {
  private entries: CacheEntry[] = [];
  async get(question: string, sig: string, intent = 'answer'): Promise<unknown | null> {
    if (intent === 'more') return null; // "another option" never reuses
    const now = Date.now();
    this.entries = this.entries.filter((e) => now - e.at < CACHE_TTL_MS);
    const sameSig = this.entries.filter((e) => e.sig === sig);
    if (sameSig.length === 0) return null;
    const vecs = await embed([question]);
    if (!vecs) return null;
    for (const e of sameSig) {
      if (cosine(vecs[0], e.qVec) >= CACHE_COSINE_MIN) return e.answer;
    }
    return null;
  }
  async put(question: string, sig: string, answer: unknown): Promise<void> {
    const vecs = await embed([question]);
    if (!vecs) return;
    this.entries.push({ sig, qVec: vecs[0], question, answer, at: Date.now() });
    if (this.entries.length > CACHE_MAX) this.entries.shift();
  }
  size() { return this.entries.length; }
}
