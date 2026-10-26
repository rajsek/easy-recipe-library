import test from 'node:test';
import assert from 'node:assert/strict';
import { CommTrace, MemoryTraceStore, redactSecrets } from './comm-trace.js';

process.env.BRIDGE_KEY = 'trace-test passphrase';

test('redaction strips bearer tokens, api keys, auth headers', () => {
  const s = 'Authorization: Bearer abc.def.ghi and api_key: gsk_1234567890ABC and token=hunter2xyz';
  const r = redactSecrets(s);
  assert.ok(!/abc\.def\.ghi/.test(r));
  assert.ok(!/gsk_1234567890ABC/.test(r));
  assert.ok(!/hunter2xyz/.test(r));
  assert.ok(/\[redacted\]/.test(r));
});

test('trace roundtrip: encrypted at rest, readable with the key, secrets stripped', async () => {
  const store = new MemoryTraceStore();
  const trace = CommTrace.fromEnv(store);
  assert.equal(trace.enabled, true);
  await trace.record({
    request_id: 'r1', ts: new Date().toISOString(), mode: 'ai',
    request_text: 'dinner ideas, no peanut',
    outbound_payload: 'question + 12 candidates (Authorization: Bearer shouldnotappear123)',
    reply_text: 'try the pongal',
    handling: 'filters: diet=any meal=any; 12 candidates; status 200',
    status: 'ok', model: 'openai/gpt-oss-120b', prompt_version: 'ask-v2-json',
  });
  const raw = (await store.list())[0];
  assert.ok(!raw.includes('pongal'), 'stored line must be ciphertext');
  const all = await trace.readAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].request_id, 'r1');
  assert.equal(all[0].reply_text, 'try the pongal');
  assert.ok(!/shouldnotappear123/.test(all[0].outbound_payload), 'secret stripped before encryption');
  assert.equal(all[0].handling.includes('12 candidates'), true);
});

test('without BRIDGE_KEY the trace is off and stores nothing (no plaintext fallback)', async () => {
  delete process.env.BRIDGE_KEY;
  const store = new MemoryTraceStore();
  const trace = CommTrace.fromEnv(store);
  assert.equal(trace.enabled, false);
  await trace.record({ request_id: 'r2', ts: '', mode: 'ai', request_text: 'x', outbound_payload: 'y', reply_text: 'z', handling: '', status: 'ok' });
  assert.equal((await store.list()).length, 0);
});
