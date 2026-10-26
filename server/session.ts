/**
 * App-managed ask sessions. The AI provider is stateless; the APP owns the
 * conversation context and sends only a compact, relevant slice with each
 * follow-up. Demo store is per-instance memory - it resets on restart, like
 * demo history, and says so.
 */
export interface AskSession {
  diet: string;
  meal: string;
  exclusions: string[];
  lastVideoIds: string[];
  updatedAt: number;
}

const TTL_MS = 30 * 60 * 1000;
const sessions = new Map<string, AskSession>();

export function getSession(id: string): AskSession | null {
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.updatedAt > TTL_MS) { sessions.delete(id); return null; }
  return s;
}

export function putSession(id: string, patch: Partial<AskSession>): AskSession {
  const cur = getSession(id) || { diet: '', meal: '', exclusions: [], lastVideoIds: [], updatedAt: 0 };
  const next: AskSession = { ...cur, ...patch, updatedAt: Date.now() };
  sessions.set(id, next);
  return next;
}

export function clearSession(id: string): void {
  sessions.delete(id);
}

// A follow-up that means "give me a different answer for the SAME request".
const MORE_RE = /^(ok\s+)?(another|one more|something else|anything else|what else|different|next|else|more)\b/i;
export function isMoreIntent(question: string): boolean {
  return MORE_RE.test(String(question || '').trim());
}

export function validSessionId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9-]{8,64}$/.test(id);
}
