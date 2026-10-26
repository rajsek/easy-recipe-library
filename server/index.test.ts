import test from 'node:test';
import assert from 'node:assert/strict';
import { _setEmbedFnForTests } from './semantic.js';

// Fake Groq provider via fetch stub - no network, deterministic usage numbers.
process.env.AI_PROVIDER = 'groq';
process.env.GROQ_API_KEY = 'test-key';
process.env.SEMANTIC = 'on';
process.env.DATA_MODE = 'demo';
process.env.BRIDGE_KEY = ''; // trace disabled: keeps the test hermetic

let groqCalls = 0;
const realFetch = globalThis.fetch;
(globalThis as any).fetch = async (url: any, init: any) => {
  if (!/api\.groq\.com/.test(String(url))) return realFetch(url, init);
  groqCalls++;
  const prompt = JSON.parse(init.body).messages?.[0]?.content || '';
  const isClassify = prompt.startsWith('Classify each word');
  const text = isClassify
    ? '{"quick":"mood","snack":"mood","dinner":"mood"}'
    : '{"text":"Besan Bread Toast fits.","ids":[1]}';
  return new Response(JSON.stringify({
    id: 'chatcmpl-test-' + groqCalls,
    model: 'openai/gpt-oss-120b',
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
};

// Deterministic fake embedder: same text -> same vector; words map to dims.
// Lets the semantic cache/rank run without the 22MB model in tests.
_setEmbedFnForTests(async (texts: string[]) => texts.map((t) => {
  const v = new Array(8).fill(0);
  for (const w of String(t).toLowerCase().split(/[^a-z]+/)) {
    let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    v[h % 8] += 1;
  }
  return v;
}));

const { default: app } = await import('./index.js');
const server = await new Promise<any>((resolve) => {
  const s = app.listen(0, '127.0.0.1', () => resolve(s));
});
const base = 'http://127.0.0.1:' + server.address().port;

async function ask(body: any) {
  const r = await fetch(base + '/api/ask-ai', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, json: await r.json() };
}

test.after(() => { server.close(); (globalThis as any).fetch = realFetch; _setEmbedFnForTests(null); });

test('ask-ai answers and records provider-reported usage', async () => {
  const before = groqCalls;
  const { status, json } = await ask({ question: 'quick snack?', session_id: 'testsession0001' });
  assert.equal(status, 200);
  assert.equal(typeof json.answer, 'string');
  assert.ok(json.usage.total > 0, 'provider-reported tokens surfaced');
  assert.ok(json.usage.calls >= 1);
  assert.ok(groqCalls > before);
  assert.equal(json.session.session_id, 'testsession0001');
});

test('semantic cache: same question + same constraints reuses the answer with 0 model calls', async () => {
  await ask({ question: 'quick snack?', session_id: 'testsession0002' });
  const before = groqCalls;
  const { json } = await ask({ question: 'quick snack?', session_id: 'testsession0002' });
  assert.equal(json.cached, true, 'second identical ask served from the semantic cache');
  assert.equal(json.usage, undefined, 'no fresh usage on a cache hit');
  assert.equal(groqCalls, before, 'no model call on a cache hit');
});

test('semantic cache: different hard constraints NEVER reuse (diet change -> new model call)', async () => {
  const before = groqCalls;
  const { json } = await ask({ question: 'quick snack?', session_id: 'testsession0002', diet: 'Non-veg' });
  assert.notEqual(json.cached, true);
  assert.ok(groqCalls > before, 'constraint change bypasses the cache');
});

test('session follow-up: "another option" continues with stored constraints', async () => {
  await ask({ question: 'dinner idea?', diet: 'Veg', meal: 'dinner', session_id: 'testsession0003' });
  const { json } = await ask({ question: 'another option', session_id: 'testsession0003' });
  assert.equal(json.session.continued, true);
  assert.equal(json.session.diet, 'Veg', 'stored diet carried into the follow-up');
  assert.equal(json.session.meal, 'dinner');
});

test('session reset clears stored context', async () => {
  const r = await fetch(base + '/api/session/reset', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 'testsession0003' }) });
  const j = await r.json();
  assert.equal(j.cleared, true);
  const { json } = await ask({ question: 'another option', session_id: 'testsession0003' });
  assert.equal(json.session.continued, false, 'no continuation after reset');
});

test('pick fills a thin checked pool with labelled video alternatives', async () => {
  const r = await fetch(base + '/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diet: '', meal: '', note: 'corn' }) });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(Array.isArray(j.picks), 'picks array');
  assert.ok(Array.isArray(j.videos), 'videos array always present on pick');
  assert.ok(j.picks.length >= 1, 'corn matches at least one checked recipe');
  assert.ok(j.picks.some((p: any) => /corn/i.test(p.name)), 'the corn card is picked');
  assert.ok(j.videos.length <= Math.max(0, 5 - j.picks.length), 'video fill never exceeds the 5 idea budget');
  const ids = new Set<string>();
  for (const v of j.videos) {
    assert.equal(v.status, 'video found - details not extracted yet', 'video alternatives stay honestly labelled');
    assert.ok(!ids.has(v.video_id), 'video alternatives have unique ids');
    ids.add(v.video_id);
    assert.ok(!j.picks.some((p: any) => String(p.url).includes(v.video_id)), 'no alternative duplicates a picked card');
  }
});

test('zero checked picks still get labelled video alternatives (no dead end)', async () => {
  // Exhaust the corn pool in this process (demo memory exclusions accumulate),
  // then the response with 0 picks must still offer the corn videos.
  let j: any = null;
  for (let i = 0; i < 6; i++) {
    const r = await fetch(base + '/api/pick', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ diet: '', meal: '', note: 'corn' }) });
    assert.equal(r.status, 200);
    j = await r.json();
    if (j.picks.length === 0) break;
  }
  assert.equal(j.picks.length, 0, 'corn pool exhausted in this instance');
  assert.ok(Array.isArray(j.videos) && j.videos.length >= 3, 'video alternatives present even with zero picks, got ' + JSON.stringify(j.videos && j.videos.length));
  for (const v of j.videos) {
    assert.ok(typeof v.status === 'string' && v.status.includes('details not extracted yet'));
  }
});
