/**
 * Shared-queue Google Docs adapter ("Ask Instinct" mode) - INERT until the
 * Google connection exists and GOOGLE_SERVICE_ACCOUNT_JSON + QUEUE_DOC_ID
 * are set. Untested against the live Docs API; wire-up and latency testing
 * happen after the service account lands. Do not set the env vars before
 * that test passes.
 *
 * Design (per owner steering): the app appends the user's question to one
 * private Google Doc shared with only the user and the service account. A
 * wake subscription on that Doc pings the assistant ON DEMAND - no polling.
 * Conversation state lives in the Queue Sheet tab: a session opens only on
 * an authenticated app Send, carries last_response_ts, and closes 10 minutes
 * after the last response; late Doc events never revive a closed session, a
 * new Send opens a new one, and the event filter excludes the assistant's
 * own answer writes. Doc content is untrusted data within recipe scope only.
 */

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

// Appends one timestamped question to the queue Doc. Docs API:
// documents.batchUpdate with an insertText at end-of-segment. Auth is a
// service-account JWT exchanged at oauth2.googleapis.com/token.
export async function appendQueueQuestion(cfg: QueueDocConfig, question: string): Promise<void> {
  throw new Error('docs queue adapter not tested yet - do not call before the Google connection is verified');
}
