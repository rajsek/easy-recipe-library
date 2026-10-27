import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProfile } from './data.js';

// Logical profile separation: names normalize to one stable key, and rows
// written under one profile never appear in another profile's reads.

test('normalizeProfile collapses case/space variants into one key', () => {
  assert.equal(normalizeProfile('Raja'), 'raja');
  assert.equal(normalizeProfile('  Raja   Sekar '), 'raja sekar');
  assert.equal(normalizeProfile('AMMA'), 'amma');
  assert.equal(normalizeProfile(''), '');
  assert.equal(normalizeProfile(undefined), '');
  assert.equal(normalizeProfile(null), '');
  assert.ok(normalizeProfile('x'.repeat(100)).length <= 40);
});

test('profile namespaces are distinct: A never equals B after normalization', () => {
  const a = normalizeProfile('Raja');
  const b = normalizeProfile('Amma');
  assert.notEqual(a, b);
  // A row's stored profile only matches its own namespace
  const rows = [
    { profile: 'raja', note: 'his' },
    { profile: 'amma', note: 'hers' },
    { profile: '', note: 'legacy pre-profile row' },
  ];
  const forProfile = (p: string) => rows.filter((r) => normalizeProfile(r.profile) === normalizeProfile(p));
  assert.deepEqual(forProfile('Raja').map((r) => r.note), ['his']);
  assert.deepEqual(forProfile('Amma').map((r) => r.note), ['hers']);
  // Legacy rows stay with the default namespace only - never re-attributed.
  assert.deepEqual(forProfile('').map((r) => r.note), ['legacy pre-profile row']);
  assert.deepEqual(forProfile('Someone New').map((r) => r.note), []);
});
