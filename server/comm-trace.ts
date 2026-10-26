// Communication trace: an encrypted, user-inspectable record of what the app
// sent and received for each request, so the owner can spot a bad request or
// reply later and correct it. Contents are encrypted at rest with the
// audit-log HKDF subkey (bridge-crypto.ts); the trace view requires the app
// token. In demo mode the store is memory-only and resets on restart - the
// persistent Sheet-backed store lands with the Google connection.
//
// NEVER recorded: passwords, tokens, API keys, Authorization headers.
// The "why" recorded here is the factual pipeline outcome (filters applied,
// candidates matched, status) - not model chain-of-thought, not internals.
import { bridgeKeyFromEnv, deriveSubkey, encryptLine, decryptLine } from './bridge-crypto.js';

export type TraceMode = 'ai' | 'bridge' | 'whatsapp-handoff';

export interface TraceEntry {
  request_id: string;
  ts: string; // ISO
  mode: TraceMode;
  request_text: string;      // what the user submitted
  outbound_payload: string;  // what the app actually sent to AI/bridge (sanitised)
  reply_text: string;        // what came back (sanitised)
  handling: string;          // factual outcome: filters applied, candidates matched, status
  status: 'ok' | 'error';
  error?: string;
  retries?: number;
  model?: string;
  prompt_version?: string;
}

// Strip anything that looks like a secret before any storage or log line.
const SECRET_RES = [
  /bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /(?:api[_-]?key|token|secret|password|authorization)["'\s:=]+[A-Za-z0-9._~+/=-]{6,}/gi,
  /gsk_[A-Za-z0-9]{10,}/g, // groq key shape
];
export function redactSecrets(s: string): string {
  let out = String(s ?? '');
  for (const re of SECRET_RES) out = out.replace(re, '[redacted]');
  return out;
}

export interface TraceStore {
  append(encrypted: string): Promise<void>;
  list(): Promise<string[]>; // encrypted lines, oldest first
  clear(): Promise<void>;
}

export class MemoryTraceStore implements TraceStore {
  private lines: string[] = [];
  async append(encrypted: string): Promise<void> { this.lines.push(encrypted); }
  async list(): Promise<string[]> { return [...this.lines]; }
  async clear(): Promise<void> { this.lines = []; }
}

export class CommTrace {
  constructor(private store: TraceStore, private auditKey: Buffer | undefined) {}
  static fromEnv(store: TraceStore): CommTrace {
    const master = bridgeKeyFromEnv(process.env.BRIDGE_KEY);
    return new CommTrace(store, master ? deriveSubkey(master, 'audit-log') : undefined);
  }
  get enabled(): boolean { return !!this.auditKey; }
  async record(e: TraceEntry): Promise<void> {
    if (!this.auditKey) return; // no key configured: trace off, never plaintext fallback
    const clean: TraceEntry = {
      ...e,
      request_text: redactSecrets(e.request_text),
      outbound_payload: redactSecrets(e.outbound_payload),
      reply_text: redactSecrets(e.reply_text),
      handling: redactSecrets(e.handling),
      error: e.error ? redactSecrets(e.error) : undefined,
    };
    await this.store.append(encryptLine(this.auditKey, JSON.stringify(clean)));
  }
  async readAll(): Promise<TraceEntry[]> {
    if (!this.auditKey) return [];
    const out: TraceEntry[] = [];
    for (const line of await this.store.list()) {
      const dec = decryptLine(this.auditKey, line);
      if (dec) { try { out.push(JSON.parse(dec)); } catch { /* skip corrupt */ } }
    }
    return out;
  }
}
