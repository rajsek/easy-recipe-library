import test from 'node:test';
import assert from 'node:assert/strict';

// Simulate the module with a controllable localStorage + fetch
function freshStorage() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    _map: m,
  };
}

test('stale pre-unlock 401 must not wipe a token saved after the request started', async () => {
  (globalThis as any).localStorage = freshStorage();
  const { apiFetch, setAuthToken } = await import('../web/src/api.js');
  let locked = 0;
  const { setOnAuthRequired } = await import('../web/src/api.js');
  setOnAuthRequired(() => locked++);

  // request fired before unlock, resolves 401 AFTER the user unlocks
  let resolveReq: (r: any) => void;
  const slow = new Promise((res) => { resolveReq = res; });
  (globalThis as any).fetch = () => slow;
  const pending = apiFetch('/api/recipes').catch((e) => e.message);

  setAuthToken('new-valid-token'); // user unlocks meanwhile
  resolveReq!({ status: 401 });
  assert.equal(await pending, 'unauthorized');
  assert.equal((globalThis as any).localStorage.getItem('app_token'), 'new-valid-token', 'fresh token must survive the stale 401');
  assert.equal(locked, 0, 'app must not re-lock after a successful unlock');
});

test('401 for the CURRENT token still wipes and locks', async () => {
  (globalThis as any).localStorage = freshStorage();
  const { apiFetch, setAuthToken, setOnAuthRequired } = await import('../web/src/api.js');
  let locked = 0;
  setOnAuthRequired(() => locked++);
  setAuthToken('revoked-token');
  (globalThis as any).fetch = async () => ({ status: 401 });
  await assert.rejects(apiFetch('/api/state'), /unauthorized/);
  assert.equal((globalThis as any).localStorage.getItem('app_token'), null);
  assert.equal(locked, 1);
});
