import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyToken } from '../web/src/unlock.js';

test('verifyToken maps 401 to wrong password, 200 to ok, errors to network', async () => {
  assert.equal(await verifyToken('bad', async () => ({ status: 401, ok: false })), 'wrong');
  assert.equal(await verifyToken('good', async () => ({ status: 200, ok: true })), 'ok');
  assert.equal(await verifyToken('x', async () => ({ status: 500, ok: false })), 'network');
  assert.equal(await verifyToken('x', async () => { throw new Error('down'); }), 'network');
  let sent: any = null;
  await verifyToken('tok123', async (url, init) => { sent = { url, init }; return { status: 200, ok: true }; });
  assert.equal(sent.url, '/api/state');
  assert.equal(sent.init.headers.Authorization, 'Bearer tok123');
});
