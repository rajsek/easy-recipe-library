import React, { useEffect, useState, useCallback } from 'react';

interface VideoItem { id: string; title: string; channel: string; url: string; thumb: string; views: string; category: string; diet: string; published: string; status: string; }
interface Recipe { name: string; url: string; channel: string; diet: string; meal: string; time: string; ingredients: string; steps: string[]; source: string; partial: boolean; }
interface HistoryEntry { date: string; id: string; title: string; state: string; }
interface PickResult { count: number; usedAI: boolean; note: string; noteInfo?: string; interpreted?: { from: string; to: string }[]; picks: { name: string; url: string; time: string; diet: string; meal: string; reason: string }[]; }

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
  ['all', 'All videos'], ['history', 'History'], ['comms', 'Comms']
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


// At-a-glance ingredient icons: bundled inline SVGs (deterministic, no font or
// network dependency), each with an accessible category label. Icons only aid
// scanning - the exact sourced text always stays visible, and anything with no
// confident category gets a neutral dot, never a guessed icon.
const ICON_SVG: Record<string, string> = {
  onion: '<circle cx="12" cy="14" r="6.5"/><path d="M12 7.5V3M9.5 10.5c-1 1.6-1 3.8 0 5.6M14.5 10.5c1 1.6 1 3.8 0 5.6"/>',
  tomato: '<circle cx="12" cy="13.5" r="6.5"/><path d="M12 7V4.5M8.8 7.5 12 9.2l3.2-1.7"/>',
  garlic: '<path d="M12 4.5c1.8 2.2 4.5 5.2 4.5 9a4.5 4.5 0 0 1-9 0c0-3.8 2.7-6.8 4.5-9z"/><path d="M12 4.5V3M10.5 18.5 9.8 20M13.5 18.5l.7 1.5M12 18.5V20"/>',
  root: '<ellipse cx="12" cy="13.5" rx="5.5" ry="7" transform="rotate(20 12 13.5)"/><path d="M14.5 7c1-2 2.5-3 4.5-3.5M14.5 7c-0.5-2-0.2-3.5 1-4.8"/>',
  chilli: '<path d="M8 7.5c-2.5 6 1.5 11.5 8 12 3.2.2 5.5-1 5.5-1s-3 .3-6-.5C12 16.8 9.5 12.7 10.5 8c.3-1.4-1.6-1.9-2.5-.5z"/><path d="M10.5 8c.2-2 1.4-3.2 3.2-3.6"/>',
  spice: '<rect x="7" y="9.5" width="10" height="10.5" rx="2"/><path d="M9.5 9.5V7.5h5v2M10.5 7.5v-2h3v2M10 13.5h.01M14 13.5h.01M12 16.5h.01"/>',
  grain: '<path d="M12 21V8"/><path d="M12 8c0-2.8-1.8-4.5-4.5-4.5C7.5 6.5 9.4 8 12 8zM12 8c0-2.8 1.8-4.5 4.5-4.5C16.5 6.5 14.6 8 12 8zM12 13.5c0-2.8-1.8-4.5-4.5-4.5 0 3 1.9 4.5 4.5 4.5zM12 13.5c0-2.8 1.8-4.5 4.5-4.5 0 3-1.9 4.5-4.5 4.5z"/>',
  oil: '<path d="M10 3.5h4V6l2 3v10a1.5 1.5 0 0 1-1.5 1.5h-5A1.5 1.5 0 0 1 8 19V9l2-3z"/><path d="M8 12h8"/>',
  dairy: '<path d="M7.5 9.5 10 4h4l2.5 5.5V20h-9z"/><path d="M7.5 9.5h9M12 9.5V4"/>',
  egg: '<path d="M12 4.5c2.6 3 4.8 6.4 4.8 9.7a4.8 4.8 0 0 1-9.6 0c0-3.3 2.2-6.7 4.8-9.7z"/>',
  meat: '<circle cx="9" cy="9" r="5"/><path d="m12.6 12.6 4.2 4.2"/><circle cx="18.6" cy="15.9" r="1.5"/><circle cx="15.9" cy="18.6" r="1.5"/>',
  fish: '<path d="M6.5 12c2.3-2.8 5-4 8.5-4 2.8 0 4.8 1.7 6 4-1.2 2.3-3.2 4-6 4-3.5 0-6.2-1.2-8.5-4z"/><path d="M6.5 12 3.5 9v6z"/><circle cx="15.5" cy="11" r=".7" fill="currentColor" stroke="none"/>',
  legume: '<path d="M9 4.5c5.5.5 10.5 5.5 10.5 10.5a4.5 4.5 0 0 1-4.5 4.5C9.5 19.5 4.5 13.5 4.5 9A4.5 4.5 0 0 1 9 4.5z"/><path d="M9.5 8.5c2.8 1 5.5 3.8 6.5 7"/>',
  nut: '<ellipse cx="12" cy="8" rx="3.8" ry="4.4"/><ellipse cx="12" cy="16.2" rx="3.8" ry="4.4"/>',
  veg: '<path d="M12 13v7M8.5 20.5h7"/><circle cx="8.3" cy="9.5" r="3.3"/><circle cx="15.7" cy="9.5" r="3.3"/><circle cx="12" cy="6.8" r="3.3"/>',
  herb: '<path d="M12 21v-8"/><path d="M12 13c-3.8 0-6-2.4-6-6 3.6 0 6 2.2 6 6zM12 13c3.8 0 6-2.4 6-6-3.6 0-6 2.2-6 6z"/>',
  fruit: '<circle cx="12" cy="13.5" r="6.3"/><path d="M12 7.2V4.5M12 7.2c0-1.8 1.2-2.9 3-3.2.2 1.8-1 3-3 3.2z"/>',
  sweet: '<rect x="6.5" y="8" width="11" height="11" rx="1.5"/><path d="M6.5 13.5h11M12 8v11"/>',
  water: '<path d="M12 3.5c2.5 3.5 5.3 6.8 5.3 10.3a5.3 5.3 0 0 1-10.6 0C6.7 10.3 9.5 7 12 3.5z"/>',
  generic: '<circle cx="12" cy="12" r="6.5"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/>'
};
const ING_ICONS: [RegExp, string][] = [
  [/coriander leaves|cilantro|kothamalli|curry leaves|karuveppilai|mint|pudina/i, 'herb'],
  [/onion|shallot|vengayam/i, 'onion'], [/tomato|thakkali/i, 'tomato'], [/garlic|poondu/i, 'garlic'],
  [/green chilli|red chilli|chilli|chili|milagai|milakku/i, 'chilli'],
  [/potato|aloo|urulai|carrot|beetroot|ginger|inji|radish|mullangi/i, 'root'],
  [/pepper|milagu|turmeric|manjal|cumin|jeera|seeragam|coriander powder|fennel|sombu|cardamom|elakkai|cinnamon|pattai|clove|krambu|ajwain|omam|masala|hing|perungayam|mustard|kadugu|tamarind|puli|salt|uppu|spice/i, 'spice'],
  [/rice|arisi|wheat|atta|maida|flour|maavu|besan|gram flour|rava|semolina|sooji|jowar|millet|cholam|bread|poha|aval|oats/i, 'grain'],
  [/\bdal\b|paruppu|lentil|soya|meal maker|\bbeans\b|\bpeas\b|pattani|chana|chickpea|kadalai|gram\b/i, 'legume'],
  [/oil|ennai/i, 'oil'],
  [/ghee|nei\b|butter|milk|paal|curd|yogurt|thayir|paneer|cheese|cream/i, 'dairy'],
  [/^\d*\s*egg|\beggs?\b|muttai/i, 'egg'],
  [/chicken|kozhi|mutton|lamb|\bmeat\b|beef|pork/i, 'meat'],
  [/fish|meen|prawn|shrimp|eral|crab|nandu/i, 'fish'],
  [/coconut|thengai|cashew|almond|peanut|groundnut|nilakadalai|\bnuts?\b|munthiri/i, 'nut'],
  [/spinach|keerai|greens|cabbage|cauliflower|broccoli|brinjal|eggplant|kathirikai|cucumber|corn\b|okra|vendakkai|mushroom|kaalan|capsicum|bell pepper|karamani|drumstick|murungai|beans\b/i, 'veg'],
  [/lemon|elumichai|banana|vazhai|apple|mango|mambazham|pineapple|grapes/i, 'fruit'],
  [/sugar|jaggery|vellam|honey|then\b|chocolate|cocoa/i, 'sweet'],
  [/water|thanni|coconut milk/i, 'water']
];
function ingIconKey(item: string): string {
  for (const [re, key] of ING_ICONS) if (re.test(item)) return key;
  return 'generic';
}
function IngIcon({ item }: { item: string }) {
  const k = ingIconKey(item);
  const svg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_SVG[k] || ICON_SVG.generic) + '</svg>';
  return <span className="ingicon" role="img" aria-label={k === 'generic' ? 'ingredient' : k} title={k === 'generic' ? 'ingredient' : k} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * Splits sourced ingredient prose into display items WITHOUT losing meaning:
 * a new item starts only at a sentence boundary or where a quantity/label
 * leads the segment ("200g soya chunks", "1 tsp pepper", "Spice powder: 2 tsp
 * coriander"). Bare prep fragments ("grind", "dry roast 2 min") stay attached
 * to the ingredient they belong to instead of becoming fake grocery items.
 * The text itself is never rewritten - only grouped.
 */
function splitIngredients(text: string): string[] {
  const qtyLead = /^(\D{0,9})(\d|½|¼|¾|a pinch|a few|handful|one\b|two\b)/i;
  const items: string[] = [];
  for (const sentence of String(text || '').split(/\. (?=[A-Z])/)) {
    let cur = '';
    for (const part of sentence.split(/,\s*/)) {
      const t = part.trim();
      if (!t) continue;
      if (cur === '' || qtyLead.test(t)) {
        if (cur) items.push(cur);
        cur = t;
      } else {
        cur += ', ' + t;
      }
    }
    if (cur) items.push(cur);
  }
  return items.map((s) => s.replace(/\.$/, ''));
}
function IngredientList({ text }: { text: string }) {
  const items = splitIngredients(text);
  return (
    <ul className="inglist">
      {items.map((it, i) => (
        <li key={i}><IngIcon item={it} /><span>{it}</span></li>
      ))}
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
    if (t === 'comms') loadTraces();
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
  const [askMode, setAskMode] = useState<'ai' | 'whatsapp'>('ai');
  const [askAiState, setAskAiState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  interface AskRecipe { name: string; url: string; time: string; diet: string; meal: string; reason: string }
  const [askAiResult, setAskAiResult] = useState<{ text: string; recipes: AskRecipe[]; question: string; diet: string; meal: string } | null>(null);
  const [askAiError, setAskAiError] = useState('');
  const [pickForm, setPickForm] = useState<{ note: string; diet: string; meal: string } | null>(null);
  interface TraceRow { request_id: string; ts: string; mode: string; request_text: string; outbound_payload: string; reply_text: string; handling: string; status: string; error?: string }
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [tracesNote, setTracesNote] = useState('');
  const [aiOn, setAiOn] = useState(false);

  const loadHistory = useCallback(() => {
    apiFetch('/api/history').then((r) => r.json()).then(setHistory).catch(() => {});
  }, []);

  const loadTraces = useCallback(() => {
    apiFetch('/api/traces').then((r) => r.json()).then((j) => {
      setTraces(j.traces || []);
      setTracesNote(j.enabled ? (j.note || '') : 'Trace storage is off: no BRIDGE_KEY set on this deployment.');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch('/api/state').then((r) => r.json()).then((s) => { setDataMode(s.mode); setAiOn(!!s.ai); }).catch(() => {});
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

  async function doAskAi() {
    setAskAiState('sending'); setAskAiError(''); setAskAiResult(null);
    const q = pnote.trim(); const d = pdiet; const m = pmeal;
    try {
      const r = await apiFetch('/api/ask-ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, diet: d, meal: m })
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'could not get an answer'); }
      const { answer, recipes } = await r.json();
      setAskAiResult({ text: answer, recipes: recipes || [], question: q, diet: d, meal: m });
      setAskAiState('done');
    } catch (e: any) {
      setAskAiError(e.message || 'could not get an answer'); setAskAiState('error');
    }
  }

  async function doPick() {
    setPicking(true); setPickResult(null);
    try {
      const r = await apiFetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diet: pdiet, meal: pmeal, note: pnote })
      });
      setPickResult(await r.json());
      setPickForm({ note: pnote, diet: pdiet, meal: pmeal });
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
            {dataMode === 'demo' ? 'Recipe copy as of 26 Oct 2026 (not live) - saves/history reset on restart' : 'LIVE - your Google Sheet'}
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
            <p className="muted small">{dataMode === 'demo'
              ? 'Suggestions come only from checked recipes in a snapshot copy of your library (refreshed by the owner when the Sheet changes). Repeats are avoided only while this copy\'s memory lasts - it resets without warning.'
              : 'Suggestions come only from checked recipes, never repeated within 30 days.'}</p>
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
            {pickForm && (pickForm.note !== pnote || pickForm.diet !== pdiet || pickForm.meal !== pmeal) && (
              <p className="muted span-all">Note or filters changed since these picks - press "Give me 5 ideas" to refresh.</p>
            )}
            {pickResult.note && <p className="muted span-all">{pickResult.note}</p>}
            {pickResult.interpreted && pickResult.interpreted.length > 0 && (
              <p className="muted span-all">Interpreted as: {pickResult.interpreted.map((i) => i.to + ' (from "' + i.from + '")').join(', ')}</p>
            )}
            {pickResult.noteInfo && <p className="muted span-all">{pickResult.noteInfo}</p>}
            {!pickResult.usedAI && (
              <p className="muted span-all">AI ranking is off until you choose a provider; these are unranked matches. Ask in chat for a reasoned pick.</p>
            )}
            <div className="span-all">
              <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="radio" name="askmode" checked={askMode === 'ai'} onChange={() => setAskMode('ai')} disabled={!aiOn} />
                  Instant AI answer{!aiOn ? ' (AI off)' : ''}
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <input type="radio" name="askmode" checked={askMode === 'whatsapp'} onChange={() => setAskMode('whatsapp')} />
                  WhatsApp
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 4, opacity: 0.6 }} title="Being set up - not live yet">
                  <input type="radio" name="askmode" disabled />
                  Ask Instinct (coming soon)
                </label>
              </div>
              {askMode === 'ai' && aiOn && (
                <>
                  <button className="btn" onClick={doAskAi} disabled={askAiState === 'sending' || !pnote.trim()}>
                    {askAiState === 'sending' ? 'Asking...' : 'Ask about the note above'}
                  </button>
                  {!pnote.trim() && <p className="muted">Type a note or question above first.</p>}
                </>
              )}
              {askMode === 'whatsapp' && (
                <a
                  className="btn"
                  href={'https://wa.me/16508702892?text=' + encodeURIComponent(
                    'Meal pick request from my recipe app:\n' +
                    'Diet: ' + (pdiet || 'Veg + Non-veg') + '\n' +
                    'Meal: ' + (pmeal || 'any') +
                    (pnote.trim() ? '\nNote: ' + pnote.trim() : '') +
                    '\nPlease pick from my recipe library.'
                  )}
                  target="_blank" rel="noopener"
                >Open WhatsApp to ask</a>
              )}
              {askAiState === 'done' && askAiResult && (
                <div className="card" style={{ marginTop: 10 }}>
                  <div className="cardbody">
                    <h3>AI answer</h3>
                    <p className="muted small">
                      Answer to: "{askAiResult.question}" · {askAiResult.diet || 'Veg + Non-veg'} · {askAiResult.meal || 'Any meal'}
                    </p>
                    {(askAiResult.question !== pnote.trim() || askAiResult.diet !== pdiet || askAiResult.meal !== pmeal) && (
                      <p className="chips"><span className="chip warn">note/filters changed since this answer - press "Ask about the note above" again</span></p>
                    )}
                    <p style={{ whiteSpace: 'pre-wrap' }}>{askAiResult.text}</p>
                    {askAiResult.recipes.map((p) => (
                      <div key={p.name} style={{ borderTop: '1px solid #e5e0d8', paddingTop: 8, marginTop: 8 }}>
                        <h3>{p.name}</h3>
                        <Chips diet={p.diet} meal={p.meal} time={p.time} />
                        <a className="btn ghost" href={p.url} target="_blank" rel="noopener">Watch video</a>
                      </div>
                    ))}
                    <p className="muted">AI suggestion, not a nutrition, allergy or safety guarantee.</p>
                  </div>
                </div>
              )}
              {askAiState === 'error' && <p className="muted">{askAiError}</p>}
            </div>
            {pickResult.usedAI && (
              <p className="muted span-all">Reasons are AI taste suggestions, not nutrition, allergy or safety guarantees.</p>
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

        {tab === 'comms' && (
          <section>
            <h2>Communication trace</h2>
            <p className="muted">What the app sent and received per request, oldest first. Contents are stored encrypted; passwords, tokens and keys are never recorded.</p>
            {tracesNote && <p className="muted">{tracesNote}</p>}
            {traces.length === 0 ? <p className="muted">No traced requests yet. Ask an AI question on the Pick tab first.</p>
              : traces.map((t) => (
                <div className="card" key={t.request_id} style={{ marginBottom: 10 }}>
                  <div className="cardbody">
                    <div className="muted small">{t.ts} · {t.mode} · {t.status}{t.error ? ' · ' + t.error : ''} · id {t.request_id}</div>
                    <p><b>You asked:</b> {t.request_text}</p>
                    <p><b>Sent:</b> {t.outbound_payload}</p>
                    <p><b>Reply:</b> {t.reply_text}</p>
                    <p className="muted small">{t.handling}</p>
                  </div>
                </div>
              ))}
          </section>
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
