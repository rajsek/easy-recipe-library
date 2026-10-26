import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  serviceAccountJwt, appendQueueQuestion, queueDocConfig,
  sessionForNewRequest, sessionWindowOpen, SESSION_WINDOW_MS,
} from './docs-queue.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'recipe-queue@project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
};
const cfg = { docId: 'DOC123', serviceAccount: sa };

test('serviceAccountJwt: RS256, docs scope only, 1h expiry, verifiable signature', () => {
  const now = 1730000000000;
  const jwt = serviceAccountJwt(sa, now);
  const [h, p, s] = jwt.split('.');
  const dec = (x: string) => JSON.parse(Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  assert.equal(dec(h).alg, 'RS256');
  const payload = dec(p);
  assert.equal(payload.iss, sa.client_email);
  assert.equal(payload.scope, 'https://www.googleapis.com/auth/documents', 'documents scope ONLY - no drive/gmail');
  assert.equal(payload.exp - payload.iat, 3600);
  const ok = crypto.verify('RSA-SHA256', Buffer.from(h + '.' + p), publicKey, Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  assert.equal(ok, true, 'signature must verify against the service account public key');
});

test('appendQueueQuestion: token exchange then insertText at doc end, bearer auth on both', async () => {
  const calls: { url: string; init: any }[] = [];
  const fetchImpl = async (url: string, init: any) => {
    calls.push({ url, init });
    if (url.includes('oauth2')) return { ok: true, status: 200, json: async () => ({ access_token: 'tok-1' }) };
    if (url.endsWith(':batchUpdate')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ body: { content: [{ endIndex: 1 }, { endIndex: 342 }] } }) };
  };
  await appendQueueQuestion(cfg, 'which chutney fits idli?', { fetchImpl, now: 1730000000000 });
  assert.equal(calls.length, 3, 'token + read + batchUpdate');
  assert.equal(calls[1].init.headers.Authorization, 'Bearer tok-1');
  assert.equal(calls[2].init.headers.Authorization, 'Bearer tok-1');
  const body = JSON.parse(calls[2].init.body);
  const ins = body.requests[0].insertText;
  assert.equal(ins.location.index, 341, 'insert before the doc end newline');
  assert.match(ins.text, /QUESTION: which chutney fits idli\?/);
  assert.match(ins.text, /^\[2024-/);
});

test('appendQueueQuestion: token exchange failure is an honest error', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) });
  await assert.rejects(appendQueueQuestion(cfg, 'q', { fetchImpl }), /token exchange failed: HTTP 403/);
});

test('queueDocConfig: inert without env; rejects malformed JSON', () => {
  delete process.env.QUEUE_DOC_ID; delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  assert.equal(queueDocConfig(), null);
  process.env.QUEUE_DOC_ID = 'D'; process.env.GOOGLE_SERVICE_ACCOUNT_JSON = '{bad';
  assert.equal(queueDocConfig(), null);
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify(sa);
  assert.equal(queueDocConfig()?.docId, 'D');
  delete process.env.QUEUE_DOC_ID; delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
});

test('session: new Send opens session; follow-up within 10 min of last response continues it', () => {
  const t0 = 1730000000000;
  const first = sessionForNewRequest([], t0);
  assert.equal(first.isNew, true);
  const rows = [{ request_id: 'q1', ts: new Date(t0).toISOString(), status: 'done', answer_ts: new Date(t0 + 60000).toISOString(), session_id: first.sessionId }];
  const follow = sessionForNewRequest(rows, t0 + 60000 + 5 * 60000); // 5 min after response
  assert.deepEqual(follow, { sessionId: first.sessionId, isNew: false });
  const late = sessionForNewRequest(rows, t0 + 60000 + SESSION_WINDOW_MS + 1000); // past the window
  assert.equal(late.isNew, true, 'closed window: new Send starts a NEW session');
  assert.notEqual(late.sessionId, first.sessionId);
});

test('session: unanswered request keeps the window open; expiry measured from LAST RESPONSE not last request', () => {
  const t0 = 1730000000000;
  const pending = [{ request_id: 'q1', ts: new Date(t0).toISOString(), status: 'pending', session_id: 'sX' }];
  assert.equal(sessionForNewRequest(pending as any, t0 + 60 * 60000).isNew, false, 'awaiting first response: open');
  assert.equal(sessionWindowOpen({ request_id: 'q', ts: '', status: 'done', answer_ts: new Date(t0).toISOString() }, t0 + 9 * 60000), true);
  assert.equal(sessionWindowOpen({ request_id: 'q', ts: '', status: 'done', answer_ts: new Date(t0).toISOString() }, t0 + 11 * 60000), false);
});
