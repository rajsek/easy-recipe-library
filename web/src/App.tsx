import React, { useEffect, useState, useCallback } from 'react';

interface VideoItem { id: string; title: string; channel: string; url: string; thumb: string; views: string; category: string; diet: string; published: string; status: string; }
interface Recipe { name: string; url: string; channel: string; diet: string; meal: string; time: string; ingredients: string; steps: string[]; source: string; partial: boolean; }
interface HistoryEntry { date: string; id: string; title: string; state: string; }
interface PickResult { count: number; usedAI: boolean; note: string; noteInfo?: string; picks: { name: string; url: string; time: string; diet: string; meal: string; reason: string }[]; }

// All /api calls go through apiFetch: it attaches the saved app token and,
// on 401, drops the token and asks the app to show the unlock form again.
let authToken = localStorage.getItem('app_token') || '';
let onAuthRequired: () => void = () => {};

async function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers as any) };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  const r = await fetch(url, { ...opts, headers });
  if (r.status === 401) {
    authToken = '';
    localStorage.removeItem('app_token');
    onAuthRequired();
    throw new Error('unauthorized');
  }
  return r;
}

function TokenGate({ onUnlock }: { onUnlock: (t: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div className="tokengate">
      <p className="notein">This app is protected. Enter the app token (APP_TOKEN from your .env) to continue.</p>
      <input type="password" placeholder="App token" value={v}
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onUnlock(v.trim()); }} />
      <button className="pickbtn" disabled={!v.trim()} onClick={() => onUnlock(v.trim())}>Unlock</button>
    </div>
  );
}

const TABS: [string, string][] = [
  ['pick', 'Pick for me'], ['recipes', 'Recipes'], ['snack', 'Snacks'],
  ['breakfast', 'Breakfast'], ['lunch/dinner', 'Sunday meals'], ['sweets', 'Sweets'],
  ['all', 'All videos'], ['history', 'History']
];
const INDEX_TABS = new Set(['snack', 'breakfast', 'lunch/dinner', 'sweets', 'all']);

function videoId(url: string): string {
  const m = String(url || '').match(/v=([\w-]{11})/);
  return m ? m[1] : '';
}

function ActionButtons({ id, title, onSaved }: { id: string; title: string; onSaved: () => void }) {
  const [done, setDone] = useState('');
  async function mark(state: string) {
    setDone('saving');
    try {
      const r = await apiFetch('/api/history', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ video_id: id, title, state })
      });
      if (!r.ok) throw new Error();
      setDone(state);
      onSaved();
    } catch {
      setDone('error');
    }
  }
  if (done && done !== 'error' && done !== 'saving') return <div className="acts"><span className="badge">Saved: {done}</span></div>;
  return (
    <div className="acts">
      <button disabled={done === 'saving'} onClick={() => mark('saved-for-later')}>{done === 'error' ? 'Try again' : 'Save for later'}</button>
      <button disabled={done === 'saving'} onClick={() => mark('chosen')}>Choose this</button>
      <button disabled={done === 'saving'} onClick={() => mark('cooked')}>Cooked</button>
    </div>
  );
}

function RecipeCard({ c, onSaved }: { c: Recipe; onSaved: () => void }) {
  return (
    <div className="card">
      <h3>{c.name}</h3>
      <div className="meta">{c.channel} · {c.diet} · {c.meal}</div>
      {c.partial && <div className="meta"><span className="badge warn">quantities partly approximate - see note</span></div>}
      <div className="sec">Time</div><p>{c.time}</p>
      <div className="sec">Ingredients</div><p>{c.ingredients}</p>
      <div className="sec">Steps</div>
      <ol>{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
      <p className="notein">{c.source}</p>
      <div className="acts"><a className="watchbtn" href={c.url} target="_blank" rel="noopener">Watch video</a></div>
      <ActionButtons id={videoId(c.url)} title={c.name} onSaved={onSaved} />
    </div>
  );
}

export default function App() {
  const [tab, setTab] = useState('pick');
  const [channels, setChannels] = useState<string[]>([]);
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [dataMode, setDataMode] = useState<string>('');
  const [locked, setLocked] = useState(false);
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [fch, setFch] = useState(''); const [fdiet, setFdiet] = useState(''); const [fq, setFq] = useState('');
  const [pdiet, setPdiet] = useState(''); const [pmeal, setPmeal] = useState(''); const [pnote, setPnote] = useState('');
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const [picking, setPicking] = useState(false);

  const loadHistory = useCallback(() => {
    apiFetch('/api/history').then((r) => r.json()).then(setHistory).catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch('/api/state').then((r) => r.json()).then((s) => setDataMode(s.mode)).catch(() => {});
    apiFetch('/api/channels').then((r) => r.json()).then(setChannels).catch(() => {});
    apiFetch('/api/recipes').then((r) => r.json()).then(setRecipes).catch(() => {});
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!INDEX_TABS.has(tab)) return;
    setVideos(null);
    const cat = tab === 'all' ? '' : tab;
    const params = new URLSearchParams();
    if (cat) params.set('category', cat);
    if (fch) params.set('channel', fch);
    if (fdiet) params.set('diet', fdiet);
    if (fq) params.set('q', fq);
    apiFetch('/api/videos?' + params).then((r) => r.json()).then(setVideos).catch(() => setVideos([]));
  }, [tab, fch, fdiet, fq]);

  async function doPick() {
    setPicking(true); setPickResult(null);
    try {
      const r = await apiFetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diet: pdiet, meal: pmeal, note: pnote })
      });
      setPickResult(await r.json());
      loadHistory();
    } finally {
      setPicking(false);
    }
  }

  useEffect(() => {
    onAuthRequired = () => setLocked(true);
    return () => { onAuthRequired = () => {}; };
  }, []);

  if (locked) {
    return (
      <>
        <header>
          <h1>Easy Recipe Library</h1>
        </header>
        <TokenGate onUnlock={(t) => {
          authToken = t;
          localStorage.setItem('app_token', t);
          setLocked(false);
          window.location.reload();
        }} />
      </>
    );
  }

  return (
    <>
      <header>
        <h1>Easy Recipe Library</h1>
        <div className="sub">{dataMode === 'demo'
          ? 'Demo data - your changes here are not saved anywhere.'
          : 'Data: Google Sheet, updated as recipes are checked.'}</div>
      </header>
      <nav>
        {TABS.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}</button>
        ))}
      </nav>

      {INDEX_TABS.has(tab) && (
        <div className="filters">
          <select value={fch} onChange={(e) => setFch(e.target.value)}>
            <option value="">All channels</option>
            {channels.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <select value={fdiet} onChange={(e) => setFdiet(e.target.value)}>
            <option value="">Veg + Non-veg</option><option value="veg">Veg</option><option value="non-veg">Non-veg</option>
          </select>
          <input placeholder="Search dish..." value={fq} onChange={(e) => setFq(e.target.value)} />
        </div>
      )}

      {tab === 'pick' && (
        <div id="pickbar">
          <input placeholder="Anything specific? (e.g. no onion, quick, for kids)" value={pnote} onChange={(e) => setPnote(e.target.value)} />
          <div className="acts" style={{ margin: '0 0 8px' }}>
            <select value={pdiet} onChange={(e) => setPdiet(e.target.value)}>
              <option value="">Veg + Non-veg</option><option value="Veg">Veg</option><option value="Non-veg">Non-veg</option>
            </select>
            <select value={pmeal} onChange={(e) => setPmeal(e.target.value)}>
              <option value="">Any meal</option><option value="snack">Snack</option>
              <option value="breakfast">Breakfast</option><option value="lunch">Lunch/dinner</option>
            </select>
          </div>
          <button className="pickbtn" onClick={doPick} disabled={picking}>{picking ? 'Picking...' : 'Give me 5 ideas'}</button>
          <div className="notein">Suggestions come only from checked recipes, never repeated within 30 days.</div>
        </div>
      )}

      <div id="list">
        {tab === 'recipes' && (
          recipes.length === 0 ? <p className="note">No checked recipes yet.</p>
            : recipes.map((c) => <RecipeCard key={c.name} c={c} onSaved={loadHistory} />)
        )}

        {tab === 'pick' && pickResult && (
          <>
            {pickResult.note && <p className="note">{pickResult.note}</p>}
            {pickResult.noteInfo && <p className="note">{pickResult.noteInfo}</p>}
            {!pickResult.usedAI && (
              <p className="note">AI ranking is off until you choose a provider; these are unranked matches. Ask in chat for a reasoned pick.</p>
            )}
            {pickResult.picks.map((p) => (
              <div className="card" key={p.name}>
                <h3>{p.name}</h3>
                <div className="meta">{p.diet} · {p.meal}</div>
                {p.reason && <p>{p.reason}</p>}
                <div className="sec">Time</div><p>{p.time}</p>
                <div className="acts"><a className="watchbtn" href={p.url} target="_blank" rel="noopener">Watch video</a></div>
                <ActionButtons id={videoId(p.url)} title={p.name} onSaved={loadHistory} />
              </div>
            ))}
          </>
        )}

        {INDEX_TABS.has(tab) && (
          videos === null ? <p className="note">Loading...</p>
            : videos.length === 0 ? <p className="note">No videos match. Clear search or filters.</p>
            : videos.map((v) => (
              <div className="row" key={v.id}>
                <a href={v.url} target="_blank" rel="noopener"><img src={v.thumb} loading="lazy" alt="" /></a>
                <div className="t">
                  <a href={v.url} target="_blank" rel="noopener">{v.title}</a>
                  <div className="m">
                    {v.channel}{v.published ? ' · ' + v.published : ''} · {v.category}{' '}
                    <span className="badge">{v.diet}</span>{' '}
                    {v.status === 'raw-extracted' && <span className="badge">details captured</span>}
                  </div>
                </div>
                <ActionButtons id={v.id} title={v.title} onSaved={loadHistory} />
              </div>
            ))
        )}

        {tab === 'history' && (
          history.length === 0 ? <p className="note">Nothing saved, suggested or cooked yet.</p>
            : ['saved-for-later', 'chosen', 'cooked', 'suggested'].map((st) => {
                const rows = history.filter((h) => h.state === st);
                if (rows.length === 0) return null;
                return (
                  <React.Fragment key={st}>
                    <div className="sec" style={{ padding: '0 2px' }}>{st.replace(/-/g, ' ')}</div>
                    {rows.slice().reverse().map((h, i) => (
                      <div className="row" key={st + i}>
                        <div className="t">{h.title}<div className="m">{h.date}</div></div>
                      </div>
                    ))}
                  </React.Fragment>
                );
              })
        )}
      </div>
    </>
  );
}
