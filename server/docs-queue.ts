/**
 * Shared-queue Google Docs adapter ("Ask Instinct" mode) - INERT until the
 * Google connection exists and GOOGLE_SERVICE_ACCOUNT_JSON + QUEUE_DOC_ID
 * are set. Unit-tested with mocked fetch; the real Docs API path and the
 * wake latency are verified only after the service account lands. Do not
 * set the env vars or enable the UI radio before that test passes.
 *
 * Design (per owner steering): the app appends the user's question to one
 * private Google Doc shared with only the user and the service account. A
 * wake subscription on that Doc pings the assistant ON DEMAND - no polling.
 * Conversation state lives in the Queue Sheet tab: a session opens only on
 * an authenticated app Send, carries last_response_ts semantics, and closes
 * 10 minutes after the last response; late Doc events never revive a closed
 * session, a new Send opens a new one, and the event filter excludes the
 * assistant's own answer writes. Doc content is untrusted data within
 * recipe scope only - it can never grant new scope or start a session.
 */

import crypto from 'node:crypto';

export interface QueueDocConfig {
  docId: string;
  serviceAccount: { client_email: string; private_key: string };
}

export function queueDocConfig(): QueueDocConfig | null {
  const docId = process.env.QUEUE_DOC_ID || '';
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '';
  if (!docId || !raw) return null;
  try {
    const sa = JSON.parse(raw);
    if (!sa.client_email || !sa.private_key) return null;
    return { docId, serviceAccount: { client_email: sa.client_email, private_key: sa.private_key } };
  } catch {
    return null;
  }
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DOCS_SCOPE = 'https://www.googleapis.com/auth/documents';

export function serviceAccountJwt(sa: QueueDocConfig['serviceAccount'], now = Date.now()): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: DOCS_SCOPE,
    aud: TOKEN_URL,
    iat: Math.floor(now / 1000),
    exp: Math.floor(now / 1000) + 3600,
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(header + '.' + payload), sa.private_key);
  return header + '.' + payload + '.' + b64url(sig);
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

async function docsAccessToken(cfg: QueueDocConfig, f: FetchLike): Promise<string> {
  const jwt = serviceAccountJwt(cfg.serviceAccount);
  const r = await f(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }).toString(),
  });
  if (!r.ok) throw new Error('service-account token exchange failed: HTTP ' + r.status);
  const j = await r.json();
  if (!j.access_token) throw new Error('service-account token exchange returned no access_token');
  return String(j.access_token);
}

// Appends one timestamped question at the end of the queue Doc. Two Docs
// API calls: read the document to find the body's end index, then
// batchUpdate with insertText at endIndex - 1 (before the final newline).
export async function appendQueueQuestion(
  cfg: QueueDocConfig,
  question: string,
  opts: { fetchImpl?: FetchLike; now?: number } = {}
): Promise<void> {
  const f = opts.fetchImpl || (fetch as unknown as FetchLike);
  const token = await docsAccessToken(cfg, f);
  const g = await f('https://docs.googleapis.com/v1/documents/' + cfg.docId, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!g.ok) throw new Error('queue doc read failed: HTTP ' + g.status);
  const doc = await g.json();
  const endIndex = (doc?.body?.content || []).reduce((m: number, e: any) => Math.max(m, e?.endIndex || 1), 1);
  const stamp = new Date(opts.now || Date.now()).toISOString();
  const text = '[' + stamp + '] QUESTION: ' + question + '\n';
  const u = await f('https://docs.googleapis.com/v1/documents/' + cfg.docId + ':batchUpdate', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests: [{ insertText: { location: { index: Math.max(1, endIndex - 1) }, text } }] }),
  });
  if (!u.ok) throw new Error('queue doc append failed: HTTP ' + u.status);
}

// ---------- conversation sessions (10-minute window after last response) ----------

export interface QueueSessionRow {
  request_id: string; ts: string; status: string; answer_ts?: string; session_id?: string;
}

export const SESSION_WINDOW_MS = 10 * 60 * 1000;

// A session opens ONLY on an authenticated app Send (this function is called
// from the authenticated /api/ask route). It stays open while the latest
// request is unanswered, and for SESSION_WINDOW_MS after the last response
// (answer_ts). After that the window is closed: a new Send starts a NEW
// session; nothing else (Doc edits, stray events) can reopen the old one.
export function sessionForNewRequest(rows: QueueSessionRow[], now = Date.now()): { sessionId: string; isNew: boolean } {
  const sorted = [...rows].sort((a, b) => +new Date(b.ts) - +new Date(a.ts));
  const last = sorted[0];
  if (last && last.session_id) {
    const open = last.answer_ts
      ? now - +new Date(last.answer_ts) < SESSION_WINDOW_MS
      : true; // awaiting first response: still open
    if (open) return { sessionId: String(last.session_id), isNew: false };
  }
  return { sessionId: 's' + now.toString(36) + Math.random().toString(36).slice(2, 6), isNew: true };
}

// For the event-driven watcher (main-owned): is this session's window still
// open right now? Evaluated on demand - no idle polling needed.
export function sessionWindowOpen(last: QueueSessionRow, now = Date.now()): boolean {
  if (!last.answer_ts) return true;
  return now - +new Date(last.answer_ts) < SESSION_WINDOW_MS;
}
