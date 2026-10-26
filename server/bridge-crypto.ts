// Bridge message encryption for the shared-Doc channel.
// AES-256-GCM (Node crypto, no dependencies). One shared key, held in the
// server's BRIDGE_KEY env and the owner's vault - never in the Doc, never in
// this repo. The Doc stores only:  Q[<id>] <base64>  /  A[<id>] <base64>
// where base64 = nonce(12B) | ciphertext | GCM tag(16B).
// Honest limits: this hides message CONTENT from anyone holding the Doc link;
// it does not stop them deleting or corrupting lines, and possession of the
// key proves key-holding, not who typed the message.
import { createCipheriv, createDecipheriv, randomBytes, createHash, hkdfSync } from 'node:crypto';

const NONCE_LEN = 12;
const TAG_LEN = 16;

// Accepts a 64-char hex key or any passphrase string (hashed to 32 bytes).
export function bridgeKeyFromEnv(raw: string | undefined): Buffer | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  return createHash('sha256').update(t, 'utf8').digest();
}

// Domain separation: the single master key is never used directly. Each
// purpose gets its own HKDF subkey, so the bridge channel and the audit log
// cannot cross-decrypt, and rotating one purpose (bump its version tag)
// leaves the other untouched. The master key alone needs vault recovery.
export type KeyPurpose = 'bridge' | 'audit-log';
export function deriveSubkey(master: Buffer, purpose: KeyPurpose, version = 1): Buffer {
  return Buffer.from(hkdfSync('sha256', master, '', 'easy-recipe-library/' + purpose + '/v' + version, 32));
}

export function encryptLine(key: Buffer, plaintext: string): string {
  const nonce = randomBytes(NONCE_LEN); // unique random nonce per line - never reused
  const c = createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([nonce, ct, tag]).toString('base64');
}

// Returns undefined on any tamper/corruption (GCM auth failure) - callers
// must treat an undecryptable line as untrusted noise, never as content.
export function decryptLine(key: Buffer, b64: string): string | undefined {
  try {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length < NONCE_LEN + TAG_LEN + 1) return undefined;
    const nonce = buf.subarray(0, NONCE_LEN);
    const tag = buf.subarray(buf.length - TAG_LEN);
    const ct = buf.subarray(NONCE_LEN, buf.length - TAG_LEN);
    const d = createDecipheriv('aes-256-gcm', key, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}

const LINE_RE = /^([QA])\[([A-Za-z0-9-]{1,40})\]\s+([A-Za-z0-9+/=]+)\s*$/;

export interface BridgeLine { kind: 'Q' | 'A'; id: string; payload: string; }
export function encodeBridgeLine(kind: 'Q' | 'A', id: string, key: Buffer, plaintext: string): string {
  return kind + '[' + id + '] ' + encryptLine(key, plaintext);
}
export function parseBridgeLine(key: Buffer, line: string): BridgeLine | undefined {
  const m = LINE_RE.exec(line.trim());
  if (!m) return undefined;
  const payload = decryptLine(key, m[3]);
  if (payload === undefined) return undefined;
  return { kind: m[1] as 'Q' | 'A', id: m[2], payload };
}
