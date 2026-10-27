// Unlock-time password check: the app used to save whatever was typed and
// bounce silently back to Locked on the first 401, so a wrong password looked
// like a broken login. Verify against the API BEFORE accepting the password.
export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; ok: boolean }>;
export type UnlockCheck = 'ok' | 'wrong' | 'network';

export async function verifyToken(token: string, fetchFn?: FetchLike): Promise<UnlockCheck> {
  const f = fetchFn || ((globalThis as any).fetch as FetchLike);
  try {
    const r = await f('/api/state', { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) return 'wrong';
    return r.ok ? 'ok' : 'network';
  } catch {
    return 'network';
  }
}
