import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// Bounded stale-asset recovery: after a redeploy an OLD tab can request
// hashed assets that no longer exist. Reload once to fetch the new index;
// the sessionStorage flag prevents an infinite reload loop, and in-app
// state that matters (token, profile, plan prefs) lives in localStorage.
function installAssetReloadGuard() {
  const KEY = 'asset_reload_at';
  const recover = () => {
    const last = Number(sessionStorage.getItem(KEY) || '0');
    if (Date.now() - last < 60000) return; // already retried within a minute - stop
    sessionStorage.setItem(KEY, String(Date.now()));
    window.location.reload();
  };
  window.addEventListener('error', (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'SCRIPT' || t.tagName === 'LINK')) recover();
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const m = String((e.reason && (e.reason.message || e.reason)) || '');
    if (/dynamically imported module|Failed to fetch|Loading chunk|Importing a module script failed/i.test(m)) recover();
  });
}
installAssetReloadGuard();

// Successful boot: the index.html boot watchdog's one-shot retry flag resets,
// so a later genuine failure still gets its single hard reload.
try { sessionStorage.removeItem('erl-boot-retry'); } catch { /* storage unavailable */ }

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
