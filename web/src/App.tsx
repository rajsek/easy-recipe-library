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
    <main className="wrap">
      <div className="tokengate">
        <h2>Locked</h2>
        <p className="muted">This app is protected. Enter the app token (APP_TOKEN from your .env) to continue.</p>
        <input type="password" placeholder="App token" value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && v.trim()) onUnlock(v.trim()); }} />
        <button className="btn primary" disabled={!v.trim()} onClick={() => onUnlock(v.trim())}>Unlock</button>
      </div>
    </main>
  );
}

const TABS: [string, string][] = [
  ['pick', 'Pick for me'], ['recipes', 'Recipes'], ['snack', 'Snacks'],
  ['breakfast', 'Breakfast'], ['lunch/dinner', 'Sunday meals'], ['sweets', 'Sweets'],
  ['all', 'All videos'], ['history', 'History']
];
const INDEX_TABS = new Set(['snack', 'breakfast', 'lunch/dinner', 'sweets', 'all']);
const HIST_STATES: [string, string][] = [
  ['favourite', 'Favourites'], ['saved-for-later', 'Saved for later'],
  ['chosen', 'Selected'], ['cooked', 'Cooked'], ['suggested', 'Suggested']
];

function videoId(url: string): string {
  const m = String(url || '').match(/v=([\w-]{11})/);
  return m ? m[1] : '';
}
function thumb(url: string): string {
  const id = videoId(url);
  return id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '';
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
  if (done && done !== 'error' && done !== 'saving') {
    const label: Record<string, string> = {
      'chosen': 'Chosen - recorded in History',
      'saved-for-later': 'Saved for later',
      'cooked': 'Marked as cooked',
      'favourite': 'Added to favourites'
    };
    return <div className="acts"><span className="chip ok">✓ {label[done] || 'Saved'}</span></div>;
  }
  return (
    <div className="acts">
      <button className="btn ghost" disabled={done === 'saving'} onClick={() => mark('favourite')}>{done === 'error' ? 'Try again' : '♡ Favourite'}</button>
      <button className="btn ghost" disabled={done === 'saving'} onClick={() => mark('saved-for-later')}>Save for later</button>
      <button className="btn ghost" disabled={done === 'saving'} onClick={() => mark('chosen')}>Choose this</button>
      <button className="btn ghost" disabled={done === 'saving'} onClick={() => mark('cooked')}>Cooked</button>
    </div>
  );
}


// Small at-a-glance icons for ingredients. Icons never replace the text: the
// exact sourced ingredient (with quantity) always stays visible, and items
// with no confident keyword match get a plain bullet, not a guessed icon.
const ING_ICONS: [RegExp, string][] = [
  [/rice|arisi/i, '🍚'], [/\bdal\b|paruppu|lentil/i, '🫘'], [/onion|shallot|vengayam/i, '🧅'],
  [/tomato|thakkali/i, '🍅'], [/garlic|poondu/i, '🧄'], [/ginger|inji/i, '🫚'],
  [/green chilli|red chilli|chilli|chili|milagai/i, '🌶️'], [/pepper|milagu/i, '🌶️'],
  [/oil|ennai/i, '🫗'], [/ghee|nei\b/i, '🧈'], [/butter/i, '🧈'],
  [/salt|uppu/i, '🧂'], [/sugar/i, '🍬'], [/jaggery|vellam/i, '🍯'],
  [/honey/i, '🍯'], [/milk|paal/i, '🥛'], [/curd|yogurt|thayir/i, '🥣'],
  [/^\d*\s*egg|\beggs?\b|muttai/i, '🥚'], [/chicken|kozhi/i, '🍗'],
  [/mutton|lamb/i, '🍖'], [/fish|meen/i, '🐟'], [/prawn|shrimp|eral/i, '🦐'], [/crab/i, '🦀'],
  [/potato|aloo|urulai/i, '🥔'], [/carrot/i, '🥕'], [/beans\b/i, '🫛'],
  [/peas\b|pattani/i, '🫛'], [/capsicum|bell pepper/i, '🫑'], [/brinjal|eggplant|kathirikai/i, '🍆'],
  [/coconut|thengai/i, '🥥'], [/turmeric|manjal/i, '🟡'], [/tamarind|puli/i, '🟤'],
  [/coriander leaves|cilantro|kothamalli/i, '🌿'], [/curry leaves|karuveppilai/i, '🌿'], [/mint|pudina/i, '🌿'],
  [/spinach|keerai|greens/i, '🥬'], [/cabbage/i, '🥬'], [/cauliflower|broccoli/i, '🥦'], [/cucumber/i, '🥒'],
  [/corn\b/i, '🌽'], [/mushroom|kaalan/i, '🍄'], [/lemon/i, '🍋'], [/banana|vazhai/i, '🍌'],
  [/wheat flour|atta|maida|flour\b|maavu/i, '🌾'], [/besan|gram flour|kadalai maavu/i, '🌾'],
  [/rava|semolina|sooji/i, '🌾'], [/jowar|millet|cholam/i, '🌾'], [/bread/i, '🍞'],
  [/peanut|groundnut|nilakadalai/i, '🥜'], [/cashew|almond|nut/i, '🌰'],
  [/paneer|cheese/i, '🧀'], [/soya|meal maker/i, '🫘'], [/water|thanni/i, '💧'],
  [/turmeric|cumin|jeera|seeragam/i, '🌾'],
  [/coriander powder|cumin powder|fennel|sombu|cardamom|elakkai|cinnamon|pattai|clove|krambu|ajwain|omam|masala|hing|perungayam|mustard|kadugu|spice/i, '🫙']
];
// Older phones lack the newest emoji; test support once and fall back to a
// plain bullet so nobody sees empty boxes.
const _emojiOk: Record<string, boolean> = {};
function emojiSupported(icon: string): boolean {
  if (icon in _emojiOk) return _emojiOk[icon];
  let ok = true;
  try {
    const cv = document.createElement('canvas');
    cv.width = 24; cv.height = 24;
    const c = cv.getContext('2d');
    const draw = (ch: string) => {
      c!.clearRect(0, 0, 24, 24);
      c!.font = '16px system-ui';
      c!.textBaseline = 'top';
      c!.fillText(ch, 0, 0);
      return c!.getImageData(0, 0, 24, 24).data.join();
    };
    // An unsupported emoji rasterizes to the same hollow box as a deliberately
    // invalid codepoint; supported ones draw different pixels.
    ok = !!c && draw(icon) !== draw('\u{10FFFD}');
  } catch { ok = false; }
  _emojiOk[icon] = ok;
  return ok;
}
function ingIcon(item: string): string {
  for (const [re, icon] of ING_ICONS) if (re.test(item)) return emojiSupported(icon) ? icon : '•';
  return '•';
}
function IngredientList({ text }: { text: string }) {
  // Split into sentence chunks, then comma items; a new sentence starts at
  // ". " followed by an uppercase letter, so decimals like "1.5" stay intact.
  const items = String(text || '')
    .split(/\. (?=[A-Z])/)
    .flatMap((s) => s.split(/,\s*/))
    .map((s) => s.trim().replace(/\.$/, ''))
    .filter(Boolean);
  return (
    <ul className="inglist">
      {items.map((it, i) => {
        const icon = ingIcon(it);
        return (
          <li key={i}>
            <span className="ingicon" aria-hidden="true">{icon}</span>
            <span>{it}</span>
          </li>
        );
      })}
    </ul>
  );
}

function Chips({ diet, meal, time }: { diet?: string; meal?: string; time?: string }) {
  return (
    <div className="chips">
      {diet && <span className="chip">{diet}</span>}
      {meal && <span className="chip">{meal}</span>}
      {time && <span className="chip">{time}</span>}
    </div>
  );
}

function RecipeCard({ c, onSaved }: { c: Recipe; onSaved: () => void }) {
  return (
    <article className="card">
      <a className="thumb" href={c.url} target="_blank" rel="noopener">
        <img src={thumb(c.url)} loading="lazy" alt="" />
        <span className="play">▶</span>
      </a>
      <div className="cardbody">
        <h3>{c.name}</h3>
        <div className="muted small">{c.channel}</div>
        <Chips diet={c.diet} meal={c.meal} />
        {c.partial && <div className="chips"><span className="chip warn">quantities partly approximate - see note</span></div>}
        <details>
          <summary>Ingredients &amp; steps</summary>
          <div className="sec">Time</div><p>{c.time}</p>
          <div className="sec">Ingredients</div><IngredientList text={c.ingredients} />
          <div className="sec">Steps</div>
          <ol>{c.steps.map((s, i) => <li key={i}>{s}</li>)}</ol>
          <p className="muted small">{c.source}</p>
        </details>
        <ActionButtons id={videoId(c.url)} title={c.name} onSaved={onSaved} />
      </div>
    </article>
  );
}

export default function App() {
  const [tab, setTabState] = useState(() => {
    const h = window.location.hash.replace('#', '');
    return TABS.some(([id]) => id === h) ? h : 'pick';
  });
  const setTab = (t: string) => {
    setTabState(t);
    window.history.replaceState(null, '', '#' + t);
  };
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
      <TokenGate onUnlock={(t) => {
        authToken = t;
        localStorage.setItem('app_token', t);
        setLocked(false);
        window.location.reload();
      }} />
    );
  }

  return (
    <>
      <header className="topbar">
        <div className="wrap">
          <h1>Easy Recipe Library</h1>
          <div className={dataMode === 'demo' ? 'modebadge demo' : 'modebadge live'}>
            {dataMode === 'demo' ? 'Demo data - changes are not saved' : 'LIVE - your Google Sheet'}
          </div>
        </div>
      </header>
      <nav className="tabs">
        <div className="wrap tabrow">
          {TABS.map(([id, label]) => (
            <button key={id} className={tab === id ? 'pill on' : 'pill'} onClick={() => setTab(id)}>{label}</button>
          ))}
        </div>
      </nav>

      <main className="wrap">
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
          <section className="pickpanel">
            <h2>Tonight's ideas</h2>
            <p className="muted small">Suggestions come only from checked recipes, never repeated within 30 days.</p>
            <input placeholder="Anything specific? (e.g. no onion, quick, for kids)" value={pnote} onChange={(e) => setPnote(e.target.value)} />
            <div className="pickcontrols">
              <select value={pdiet} onChange={(e) => setPdiet(e.target.value)}>
                <option value="">Veg + Non-veg</option><option value="Veg">Veg</option><option value="Non-veg">Non-veg</option>
              </select>
              <select value={pmeal} onChange={(e) => setPmeal(e.target.value)}>
                <option value="">Any meal</option><option value="snack">Snack</option>
                <option value="breakfast">Breakfast</option><option value="lunch">Lunch/dinner</option>
              </select>
              <button className="btn primary" onClick={doPick} disabled={picking}>{picking ? 'Picking...' : 'Give me 5 ideas'}</button>
            </div>
          </section>
        )}

        {tab === 'recipes' && (
          recipes.length === 0 ? <p className="muted">No checked recipes yet.</p>
            : <div className="grid">{recipes.map((c) => <RecipeCard key={c.name} c={c} onSaved={loadHistory} />)}</div>
        )}

        {tab === 'pick' && pickResult && (
          <div className="grid">
            {pickResult.note && <p className="muted span-all">{pickResult.note}</p>}
            {pickResult.noteInfo && <p className="muted span-all">{pickResult.noteInfo}</p>}
            {!pickResult.usedAI && (
              <p className="muted span-all">AI ranking is off until you choose a provider; these are unranked matches. Ask in chat for a reasoned pick.</p>
            )}
            {pickResult.picks.map((p) => (
              <article className="card" key={p.name}>
                <a className="thumb" href={p.url} target="_blank" rel="noopener">
                  <img src={thumb(p.url)} loading="lazy" alt="" />
                  <span className="play">▶</span>
                </a>
                <div className="cardbody">
                  <h3>{p.name}</h3>
                  <Chips diet={p.diet} meal={p.meal} time={p.time} />
                  {p.reason && <p>{p.reason}</p>}
                  <a className="btn ghost" href={p.url} target="_blank" rel="noopener">Watch video</a>
                  <ActionButtons id={videoId(p.url)} title={p.name} onSaved={loadHistory} />
                </div>
              </article>
            ))}
          </div>
        )}

        {INDEX_TABS.has(tab) && (
          videos === null ? <p className="muted">Loading...</p>
            : videos.length === 0 ? <p className="muted">No videos match. Clear search or filters.</p>
            : videos.map((v) => (
              <article className="row" key={v.id}>
                <a className="rowthumb" href={v.url} target="_blank" rel="noopener"><img src={v.thumb} loading="lazy" alt="" /></a>
                <div className="rowbody">
                  <a className="rowtitle" href={v.url} target="_blank" rel="noopener">{v.title}</a>
                  <div className="muted small">{v.channel}{v.published ? ', ' + v.published : ''}</div>
                  <div className="rowmeta">
                    <span className="chip">{v.category}</span>
                    <span className="chip">{v.diet}</span>
                    {v.status === 'raw-extracted' && <span className="chip">details captured</span>}
                  </div>
                  <ActionButtons id={v.id} title={v.title} onSaved={loadHistory} />
                </div>
              </article>
            ))
        )}

        {tab === 'history' && (
          history.length === 0 ? <p className="muted">Nothing saved, suggested or cooked yet.</p>
            : HIST_STATES.map(([st, label]) => {
                const rows = history.filter((h) => h.state === st);
                if (rows.length === 0) return null;
                return (
                  <section key={st} className="histgroup">
                    <h2>{label} <span className="chip">{rows.length}</span></h2>
                    {rows.slice().reverse().map((h, i) => (
                      <div className="row hist" key={st + i}>
                        {h.id && <a className="rowthumb" href={`https://www.youtube.com/watch?v=${h.id}`} target="_blank" rel="noopener"><img src={`https://i.ytimg.com/vi/${h.id}/default.jpg`} loading="lazy" alt="" /></a>}
                        <div className="rowbody">
                          <span className="rowtitle">{h.title}</span>
                          <div className="muted small">{h.date}</div>
                        </div>
                      </div>
                    ))}
                  </section>
                );
              })
        )}
      </main>
    </>
  );
}
