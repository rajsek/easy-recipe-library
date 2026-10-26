import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeKeyFromEnv, deriveSubkey, encryptLine, decryptLine, encodeBridgeLine, parseBridgeLine } from './bridge-crypto.js';

const key = bridgeKeyFromEnv('test passphrase for bridge')!;

test('roundtrip: encrypt -> decrypt returns the exact message', () => {
  const msg = 'what can I cook tonight? no onion';
  assert.equal(decryptLine(key, encryptLine(key, msg)), msg);
});

test('nonces are unique across lines', () => {
  const a = encryptLine(key, 'same');
  const b = encryptLine(key, 'same');
  assert.notEqual(a, b, 'random nonce per line');
});

test('tampered ciphertext fails authentication, returns undefined', () => {
  const enc = encryptLine(key, 'secret');
  const raw = Buffer.from(enc, 'base64');
  raw[14] ^= 1;
  assert.equal(decryptLine(key, Buffer.from(raw).toString('base64')), undefined);
});

test('wrong key cannot decrypt', () => {
  const other = bridgeKeyFromEnv('different passphrase')!;
  assert.equal(decryptLine(other, encryptLine(key, 'secret')), undefined);
});

test('bridge line format: Q/A + id + payload roundtrip', () => {
  const line = encodeBridgeLine('Q', 'req-01', key, 'dinner ideas?');
  assert.match(line, /^Q\[req-01\] [A-Za-z0-9+/=]+$/);
  const parsed = parseBridgeLine(key, line);
  assert.deepEqual(parsed, { kind: 'Q', id: 'req-01', payload: 'dinner ideas?' });
  const answer = encodeBridgeLine('A', 'req-01', key, 'try the pongal');
  assert.deepEqual(parseBridgeLine(key, answer), { kind: 'A', id: 'req-01', payload: 'try the pongal' });
});

test('hex keys and passphrases both accepted; junk lines rejected', () => {
  const hex = 'a'.repeat(64);
  assert.equal(bridgeKeyFromEnv(hex)!.length, 32);
  assert.equal(parseBridgeLine(key, 'hello world'), undefined);
  assert.equal(parseBridgeLine(key, 'Q[] nothing'), undefined);
});

test('domain separation: bridge and audit-log subkeys cannot cross-decrypt; versions rotate independently', () => {
  const master = bridgeKeyFromEnv('master passphrase')!;
  const bridge = deriveSubkey(master, 'bridge');
  const audit = deriveSubkey(master, 'audit-log');
  const enc = encryptLine(bridge, 'question');
  assert.equal(decryptLine(audit, enc), undefined, 'audit subkey must not read bridge traffic');
  assert.equal(decryptLine(deriveSubkey(master, 'bridge'), enc), 'question');
  assert.equal(decryptLine(deriveSubkey(master, 'bridge', 2), enc), undefined, 'a rotated version starts clean');
  assert.notDeepEqual(deriveSubkey(master, 'bridge'), deriveSubkey(master, 'audit-log'));
});
