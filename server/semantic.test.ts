import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cosine, constraintSignature, SemanticCache, semanticRank, _setEmbedFnForTests, semanticStatus } from './semantic.js';

// Deterministic fake embeddings: normalized bag-of-letters vectors, so
// similar strings score high and unrelated strings score low.
function fakeEmbed(texts: string[]): Promise<number[][]> {
  return Promise.resolve(texts.map((t) => {
    const v = new Array(26).fill(0);
    for (const ch of t.toLowerCase()) {
      const i = ch.charCodeAt(0) - 97;
      if (i >= 0 && i < 26) v[i]++;
    }
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
  }));
}

test('cosine: identical vectors 1, orthogonal 0', () => {
  assert.equal(cosine([1, 0], [1, 0]).toFixed(3), '1.000');
  assert.equal(cosine([1, 0], [0, 1]).toFixed(3), '0.000');
});

test('semanticRank: orders by meaning within the given pool; null when unavailable', async () => {
  _setEmbedFnForTests(fakeEmbed);
  const rows = [
    { recipe_name: 'crispy potato snack', meal_type: 'snack', ingredients: 'potato' },
    { recipe_name: 'zz qxjv', meal_type: 'sweet', ingredients: 'zzz qqq' },
  ];
  const ranked = await semanticRank('crispy potato', rows as any, 1);
  assert.equal(ranked![0].recipe_name, 'crispy potato snack');
  _setEmbedFnForTests(null);
  const none = await semanticRank('anything', rows as any, 1);
  assert.equal(none, null, 'unavailable model -> null, never a fake semantic order');
  assert.equal(semanticStatus().available, false);
});

test('semanticRank: pool smaller than topN returns as-is without embedding', async () => {
  _setEmbedFnForTests(null);
  const rows = [{ recipe_name: 'a', meal_type: '', ingredients: '' }];
  const r = await semanticRank('q', rows as any, 5);
  assert.equal(r!.length, 1);
});

test('constraintSignature: constraint, history, library, intent and order semantics', () => {
  const base = { diet: 'Veg', meal: 'snack', exclusions: ['onion', 'nut'], foodWords: ['paneer'], excludedHash: 'h1', libraryVersion: 'lib1', intent: 'answer' };
  assert.equal(constraintSignature(base), constraintSignature({ ...base, exclusions: ['nut', 'onion'] }), 'exclusion order-insensitive');
  for (const delta of [{ diet: 'Non-veg' }, { meal: 'dinner' }, { excludedHash: 'h2' }, { libraryVersion: 'lib2' }, { intent: 'more' }, { foodWords: ['egg'] }]) {
    assert.notEqual(constraintSignature(base), constraintSignature({ ...base, ...delta }), 'differs on ' + Object.keys(delta)[0]);
  }
});

test('semantic cache: hit only when signature matches AND question is near-identical', async () => {
  _setEmbedFnForTests(fakeEmbed);
  const cache = new SemanticCache();
  const sig = constraintSignature({ diet: 'Veg', meal: '', exclusions: [], foodWords: [], excludedHash: 'h', libraryVersion: 'l', intent: 'answer' });
  await cache.put('what crispy snacks do I have', sig, { answer: 'A1' });
  const hit = await cache.get('what crispy snacks do I have?', sig);
  assert.deepEqual(hit, { answer: 'A1' });
  const otherSig = constraintSignature({ diet: 'Non-veg', meal: '', exclusions: [], foodWords: [], excludedHash: 'h', libraryVersion: 'l', intent: 'answer' });
  assert.equal(await cache.get('what crispy snacks do I have', otherSig), null, 'changed constraints bust the cache');
  assert.equal(await cache.get('zz qxjv unrelated question entirely', sig), null, 'different meaning misses');
});

test('semantic cache: "another option" intent never reuses an answer', async () => {
  _setEmbedFnForTests(fakeEmbed);
  const cache = new SemanticCache();
  const sig = constraintSignature({ diet: 'Veg', meal: '', exclusions: [], foodWords: [], excludedHash: 'h', libraryVersion: 'l', intent: 'more' });
  await cache.put('another option please', sig, { answer: 'A1' });
  assert.equal(await cache.get('another option please', sig, 'more'), null);
  _setEmbedFnForTests(null);
});

test('load: SEMANTIC=off resolves honest unavailable, never throws', async () => {
  const { loadSemantic, _resetLoadStateForTests } = await import('./semantic.js');
  _resetLoadStateForTests();
  process.env.SEMANTIC = 'off';
  const st = await loadSemantic();
  assert.equal(st.available, false);
  assert.match(String(st.reason), /disabled/);
  delete process.env.SEMANTIC;
  _resetLoadStateForTests();
});

test('load: an impossible 1ms timeout yields honest unavailable (cold-cache/download failure path), never throws, never hangs', async () => {
  const { loadSemantic, _resetLoadStateForTests } = await import('./semantic.js');
  _resetLoadStateForTests();
  process.env.SEMANTIC_LOAD_TIMEOUT_MS = '1';
  const started = Date.now();
  const st = await loadSemantic();
  assert.ok(Date.now() - started < 15000, 'bounded, no unbounded first-load hang');
  assert.equal(st.available, false, 'unavailable reported honestly');
  assert.ok(st.reason && st.reason.length > 0, 'failure reason carried');
  delete process.env.SEMANTIC_LOAD_TIMEOUT_MS;
  _resetLoadStateForTests();
});
