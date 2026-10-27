// All /api calls go through apiFetch: it attaches the saved app token and,
// on 401, drops the token and asks the app to show the unlock form again.
//
// STALE-401 GUARD: a 401 only clears the credential that the failing request
// actually used. Requests fired before an unlock (no token) can resolve AFTER
// the user unlocks; without this guard their 401 wipes the freshly saved
// token and the app bounces straight back to Locked - the "unable to login"
// loop.
let authToken = localStorage.getItem('app_token') || '';
let onAuthRequired: () => void = () => {};

// Self-declared profile name: logical separation of history/picks/queue per
// person on a shared device. NOT a login - the server treats it as a plain
// label, and anyone can type any name.
let profileName = localStorage.getItem('profile_name') || '';
let onProfileChanged: () => void = () => {};

export function profileNameRef(): string { return profileName; }
export function setProfileNameGlobal(name: string) {
  profileName = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  localStorage.setItem('profile_name', profileName);
  onProfileChanged();
}
export function setAuthToken(t: string) {
  authToken = t;
  localStorage.setItem('app_token', t);
}
export function setOnAuthRequired(fn: () => void) { onAuthRequired = fn; }
export function setOnProfileChanged(fn: () => void) { onProfileChanged = fn; }

export async function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const sentToken = authToken; // credential this request carries (may be '')
  const headers: Record<string, string> = { ...(opts.headers as any) };
  if (sentToken) headers['Authorization'] = 'Bearer ' + sentToken;
  if (profileName) headers['X-Profile'] = profileName;
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    // Only wipe when the failing credential is STILL the current one. If a
    // newer token was saved after this request started, keep it.
    if (authToken === sentToken) {
      authToken = '';
      localStorage.removeItem('app_token');
      onAuthRequired();
    }
    throw new Error('unauthorized');
  }
  return r;
}
