import React, { useEffect, useState, useCallback, useRef } from 'react';
import { taFilter, taNav, toggleSel } from './ta';
import { sortedResults, type SortKey, type TimeBucket } from './result-sort';

interface VideoItem { id: string; title: string; channel: string; url: string; thumb: string; views: string; category: string; duration_s?: string; diet: string; published: string; status: string; }
interface VideoPage { videos: VideoItem[]; total: number; page: number; pages: number; page_size: number; }
interface Recipe { name: string; url: string; channel: string; diet: string; meal: string; time: string; duration_s?: string; ingredients: string; steps: string[]; source: string; partial: boolean; }
interface HistoryEntry { date: string; id: string; title: string; state: string; }
interface PickResult { count: number; usedAI: boolean; note: string; noteInfo?: string; interpreted?: { from: string; to: string }[]; picks: { name: string; url: string; time: string; diet: string; meal: string; reason: string }[]; videos?: { video_id: string; title: string; url: string; channel: string; diet: string; status: string }[]; }

// All /api calls go through apiFetch: it attaches the saved app token and,
// on 401, drops the token and asks the app to show the unlock form again.
let authToken = localStorage.getItem('app_token') || '';
let onAuthRequired: () => void = () => {};

// Self-declared profile name: logical separation of history/picks/queue per
// person on a shared device. NOT a login - the server treats it as a plain
// label, and anyone can type any name.
let profileName = localStorage.getItem('profile_name') || '';
let onProfileChanged: () => void = () => {};
function setProfileNameGlobal(name: string) {
  profileName = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  localStorage.setItem('profile_name', profileName);
  onProfileChanged();
}

async function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers as any) };
  if (authToken) headers['Authorization'] = 'Bearer ' + authToken;
  if (profileName) headers['X-Profile'] = profileName;
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
        <p className="muted">This app is protected. Enter the app password to continue.</p>
        <input type="password" placeholder="App password" value={v}
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
  ['all', 'All videos'], ['plan', 'Plan'], ['history', 'History'], ['comms', 'Comms']
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

// A stated cook time wins. When none is stated the linked video's length is
// shown instead, always labelled so it is never mistaken for a cook time.
function videoLenChip(durationS?: string): string {
  const s = String(durationS || '').trim();
  if (!/^\d+$/.test(s)) return '';
  const m = Math.round(Number(s) / 60);
  return m > 0 ? `Video ${m} min (length, not cook time)` : '';
}

function Chips({ diet, meal, time, durationS }: { diet?: string; meal?: string; time?: string; durationS?: string }) {
  const fallback = time ? '' : videoLenChip(durationS);
  return (
    <div className="chips">
      {diet && <span className="chip">{diet}</span>}
      {meal && <span className="chip">{meal}</span>}
      {time ? <span className="chip">{time}</span> : fallback ? <span className="chip">{fallback}</span> : null}
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
        <Chips diet={c.diet} meal={c.meal} time={c.time} durationS={c.duration_s} />
        {c.partial && <div className="chips"><span className="chip warn">Incomplete/conflicting source quantities - confirm before cooking</span></div>}
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
  const [ingVocab, setIngVocab] = useState<string[]>([]);
  const [selIngs, setSelIngs] = useState<string[]>([]);
  const [dishVocab, setDishVocab] = useState<string[]>([]);
  const [selDishes, setSelDishes] = useState<string[]>([]);
  const [dishInput, setDishInput] = useState('');
  const [dishOpen, setDishOpen] = useState(false);
  const [showDishList, setShowDishList] = useState(false);
  const [showIngList, setShowIngList] = useState(false);
  const [dishIndex, setDishIndex] = useState(0);
  const [taOpen, setTaOpen] = useState(false);
  const [taIndex, setTaIndex] = useState(0);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [resultSort, setResultSort] = useState<SortKey>('original');
  const [timeBucket, setTimeBucket] = useState<TimeBucket>('');
  const [dataMode, setDataMode] = useState<string>('');
  const [locked, setLocked] = useState(false);
  const [videos, setVideos] = useState<VideoItem[] | null>(null);
  const [videoTotal, setVideoTotal] = useState(0);
  const [videoPages, setVideoPages] = useState(1);
  const [videoPage, setVideoPage] = useState(1);
  const [videoPageSize, setVideoPageSize] = useState(100);
  const [plan, setPlan] = useState<any | null>(null);
  // Plan preferences are remembered by NAME on the server (they follow the
  // profile across devices); localStorage is only a fast cache for first paint.
  const planKey = (k: string) => 'plan_' + k + '__' + (profileName || 'default');
  const [planStart, setPlanStartRaw] = useState<string>(() => localStorage.getItem(planKey('start')) || '');
  const [planLunch, setPlanLunchRaw] = useState<boolean>(() => localStorage.getItem(planKey('lunch')) === '1');
  const [planServings, setPlanServingsRaw] = useState<number>(() => parseInt(localStorage.getItem(planKey('servings')) || '2', 10) || 2);
  const savePlanPrefs = (patch: Record<string, string>) => {
    if (!profileName) return; // server requires a name; anonymous prefs stay device-local
    apiFetch('/api/prefs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefs: patch }) }).catch(() => {});
  };
  const loadPlanPrefs = () => {
    if (!profileName) return;
    apiFetch('/api/prefs').then((r) => r.json()).then((j) => {
      const p = j.prefs || {};
      if (p.plan_start !== undefined) { setPlanStartRaw(p.plan_start); localStorage.setItem(planKey('start'), p.plan_start); }
      if (p.plan_lunch !== undefined) { setPlanLunchRaw(p.plan_lunch === '1'); localStorage.setItem(planKey('lunch'), p.plan_lunch); }
      if (p.plan_servings !== undefined) { const n = parseInt(p.plan_servings, 10) || 2; setPlanServingsRaw(n); localStorage.setItem(planKey('servings'), String(n)); }
    }).catch(() => {});
  };
  const setPlanStart = (v: string) => { setPlanStartRaw(v); localStorage.setItem(planKey('start'), v); savePlanPrefs({ plan_start: v }); };
  const setPlanLunch = (v: boolean) => { setPlanLunchRaw(v); localStorage.setItem(planKey('lunch'), v ? '1' : '0'); savePlanPrefs({ plan_lunch: v ? '1' : '0' }); };
  const setPlanServings = (v: number) => { setPlanServingsRaw(v); localStorage.setItem(planKey('servings'), String(v)); savePlanPrefs({ plan_servings: String(v) }); };
  const [fch, setFch] = useState(''); const [fdiet, setFdiet] = useState(''); const [fq, setFq] = useState('');
  const [pdiet, setPdiet] = useState(''); const [pmeal, setPmeal] = useState(''); const [pnote, setPnote] = useState('');
  const noteInputRef = useRef<HTMLInputElement>(null);
  const [pickResult, setPickResult] = useState<PickResult | null>(null);
  const [extraPicks, setExtraPicks] = useState<PickResult['picks']>([]);
  const [extraVideos, setExtraVideos] = useState<NonNullable<PickResult['videos']>>([]);
  const [seenIds, setSeenIds] = useState<string[]>([]);
  const [moreState, setMoreState] = useState<'idle' | 'loading' | 'exhausted'>('idle');
  const [picking, setPicking] = useState(false);
  const [askMode, setAskMode] = useState<'ai' | 'whatsapp'>('ai');
  const [askAiState, setAskAiState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');
  interface AskRecipe { name: string; url: string; time: string; diet: string; meal: string; reason: string }
  interface AskVideo { title: string; url: string; channel: string; status: string }
  const [askAiResult, setAskAiResult] = useState<{ text: string; recipes: AskRecipe[]; videos?: AskVideo[]; question: string; diet: string; meal: string } | null>(null);
  const [askAiError, setAskAiError] = useState('');
  // App-managed conversation: the AI provider is stateless; the server keeps
  // a compact session (diet/meal/exclusions/last ideas) keyed by this id so
  // follow-ups like "another option" continue the same request.
  const [sessionId, setSessionId] = useState<string>(() => {
    let id = localStorage.getItem('ask_session_id') || '';
    if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) { id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2, 10)); localStorage.setItem('ask_session_id', id); }
    return id;
  });
  const [sessionInfo, setSessionInfo] = useState<{ continued: boolean; diet: string; meal: string } | null>(null);
  const [pickForm, setPickForm] = useState<{ note: string; composed: string; diet: string; meal: string; dishes: string[]; ings: string[] } | null>(null);
  interface TraceRow { request_id: string; ts: string; mode: string; request_text: string; outbound_payload: string; reply_text: string; handling: string; status: string; error?: string }
  const [traces, setTraces] = useState<TraceRow[]>([]);
  const [tracesNote, setTracesNote] = useState('');
  const [aiOn, setAiOn] = useState(false);
  const [semanticInfo, setSemanticInfo] = useState<{ available: boolean; reason?: string; version?: string } | null>(null);

  useEffect(() => { setResultSort('original'); setTimeBucket(''); }, [tab]);

  const loadHistory = useCallback(() => {
    apiFetch('/api/history').then((r) => r.json()).then(setHistory).catch(() => {});
    apiFetch('/api/ingredients').then((r) => r.json()).then((j) => setIngVocab(j.ingredients || [])).catch(() => {});
    apiFetch('/api/dishes').then((r) => r.json()).then((j) => setDishVocab(j.dishes || [])).catch(() => {});
  }, []);

  const loadTraces = useCallback(() => {
    apiFetch('/api/traces').then((r) => r.json()).then((j) => {
      setTraces(j.traces || []);
      setTracesNote(j.enabled ? (j.note || '') : 'Trace storage is off: no BRIDGE_KEY set on this deployment.');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    apiFetch('/api/state').then((r) => r.json()).then((s) => { setDataMode(s.mode); setAiOn(!!s.ai); setSemanticInfo(s.semantic || null); }).catch(() => {});
    apiFetch('/api/channels').then((r) => r.json()).then(setChannels).catch(() => {});
    apiFetch('/api/recipes').then((r) => r.json()).then(setRecipes).catch(() => {});
    loadHistory();
    loadPlanPrefs();
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
    if (resultSort === 'name' || resultSort === 'views' || resultSort === 'newest') params.set('sort', resultSort);
    params.set('page', String(videoPage));
    params.set('page_size', String(videoPageSize));
    const controller = new AbortController();
    apiFetch('/api/videos?' + params, {signal: controller.signal}).then((r) => { if (!r.ok) throw new Error('Video search failed'); return r.json(); }).then((j: VideoPage) => { if (!controller.signal.aborted) { setVideos(j.videos || []); setVideoTotal(j.total || 0); setVideoPages(j.pages || 1); if (j.page && j.page !== videoPage) setVideoPage(j.page); } }).catch(() => { if (!controller.signal.aborted) { setVideos([]); setVideoTotal(0); setVideoPages(1); } });
    return () => controller.abort();
  }, [tab, fch, fdiet, fq, resultSort, videoPage, videoPageSize]);

  // Any filter/sort/tab change restarts at page 1 (page is in the fetch deps,
  // so changing filters with page>1 first resets the page, then fetches).
  const resetVideoPage = useCallback(() => setVideoPage(1), []);
  useEffect(() => { resetVideoPage(); }, [tab, fch, fdiet, fq, resultSort, resetVideoPage]);

  useEffect(() => {
    if (tab !== 'plan') return;
    if (!planStart) setPlanStart(new Date().toLocaleDateString('en-CA'));
    setPlan(null);
    const params = new URLSearchParams();
    if (planStart) params.set('start', planStart);
    params.set('lunch', planLunch ? '1' : '0');
    params.set('servings', String(planServings));
    const controller = new AbortController();
    apiFetch('/api/plan?' + params, {signal: controller.signal}).then((r) => { if (!r.ok) throw new Error('Plan failed'); return r.json(); }).then(j => { if (!controller.signal.aborted) setPlan(j); }).catch(() => { if (!controller.signal.aborted) setPlan({error: true}); });
    return () => controller.abort();
  }, [tab, planStart, planLunch, planServings]);

  // Ingredient typeahead: canonical chips from the verified library vocabulary
  // (fetched once from /api/ingredients - zero AI calls per keystroke). Unknown
  // words are still allowed as free text; the answer says honestly when the
  // library has no match under the current filters.
  function taCurrentToken(): { start: number; token: string } {
    const el = noteInputRef.current;
    const pos = el ? el.selectionStart ?? pnote.length : pnote.length;
    const left = pnote.slice(0, pos);
    const m = left.match(/([a-zA-Z ]*?)$/);
    const token = (m ? m[1] : '').replace(/^\s+/, '');
    return { start: pos - token.length, token };
  }
  function taMatches(): string[] {
    const { token } = taCurrentToken();
    return taFilter(ingVocab, token);
  }
  function taPick(choice: string) {
    const { start } = taCurrentToken();
    const el = noteInputRef.current;
    const pos = el ? el.selectionStart ?? pnote.length : pnote.length;
    setPnote((pnote.slice(0, start) + pnote.slice(pos)).replace(/ {2,}/g, ' '));
    if (!selIngs.includes(choice)) setSelIngs([...selIngs, choice]);
    setTaOpen(false); setTaIndex(0);
    requestAnimationFrame(() => { const e2 = noteInputRef.current; if (e2) { e2.focus(); e2.setSelectionRange(start, start); } });
  }
  function composedNote(): string {
    const free = pnote.trim();
    if (selIngs.length === 0) return free;
    return selIngs.join(', ') + (free ? ' - ' + free : '');
  }
  const taList = taOpen ? taMatches() : [];
  // Dish filter: same typeahead semantics as ingredients (shared taFilter /
  // taNav), but chips constrain the recipe NAME (dish identity), OR across
  // selected dishes - enforced server-side, bound into the corpus fingerprint.
  const dishList = dishOpen ? taFilter(dishVocab, dishInput) : [];
  function dishPick(choice: string) {
    if (!selDishes.includes(choice)) setSelDishes([...selDishes, choice]);
    setDishInput(''); setDishOpen(false); setDishIndex(0);
  }
  async function doAskAi() {
    setAskAiState('sending'); setAskAiError(''); setAskAiResult(null);
    const q = composedNote() || (selDishes.length > 0 ? 'Dishes: ' + selDishes.join(', ') : ''); const d = pdiet; const m = pmeal;
    try {
      const r = await apiFetch('/api/ask-ai', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: q, diet: d, meal: m, session_id: sessionId, dishes: selDishes })
      });
      if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || 'could not get an answer'); }
      const j = await r.json();
      setAskAiResult({ text: j.answer, recipes: j.recipes || [], videos: j.videos || [], question: q, diet: j.session?.diet ?? d, meal: j.session?.meal ?? m });
      setSessionInfo(j.session ? { continued: !!j.session.continued, diet: j.session.diet || '', meal: j.session.meal || '' } : null);
      apiFetch('/api/state').then((r) => r.json()).then((s) => setSemanticInfo(s.semantic || null)).catch(() => {});
      setAskAiState('done');
    } catch (e: any) {
      setAskAiError(e.message || 'could not get an answer'); setAskAiState('error');
    }
  }

  async function newConversation() {
    try {
      await apiFetch('/api/session/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session_id: sessionId }) });
    } catch { /* best effort */ }
    const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2, 10);
    localStorage.setItem('ask_session_id', id);
    setSessionId(id);
    setSessionInfo(null);
    setAskAiResult(null); setAskAiState('idle');
  }

  async function doPick() {
    setPicking(true); setPickResult(null);
    try {
      const r = await apiFetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diet: pdiet, meal: pmeal, note: composedNote(), dishes: selDishes })
      });
      const j = await r.json();
      setPickResult(j);
      setPickForm({ note: pnote, composed: composedNote(), diet: pdiet, meal: pmeal, dishes: selDishes, ings: selIngs });
      // Load-more paging state: ids already on screen are sent back as `seen`
      // so the next batch is disjoint (per-instance memory is unreliable on
      // serverless; the client list is the source of truth for paging).
      setExtraPicks([]); setExtraVideos([]);
      setSeenIds([...(j.picks || []).map((p: { url: string }) => videoId(p.url)), ...(j.videos || []).map((v: { video_id: string }) => v.video_id)]);
      setMoreState('idle');
      loadHistory();
    } finally {
      setPicking(false);
    }
  }

  async function doLoadMore() {
    if (!pickForm) return;
    setMoreState('loading');
    try {
      const r = await apiFetch('/api/pick', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ diet: pickForm.diet, meal: pickForm.meal, note: pickForm.composed, dishes: pickForm.dishes, seen: seenIds })
      });
      const j = await r.json();
      const np = j.picks || [], nv = j.videos || [];
      if (np.length + nv.length === 0) { setMoreState('exhausted'); return; }
      setExtraPicks([...extraPicks, ...np]);
      setExtraVideos([...extraVideos, ...nv]);
      setSeenIds([...seenIds, ...np.map((p: { url: string }) => videoId(p.url)), ...nv.map((v: { video_id: string }) => v.video_id)]);
      setMoreState('idle');
    } catch {
      setMoreState('idle');
    }
  }

  const [profileInput, setProfileInput] = useState(profileName);

  useEffect(() => {
    onAuthRequired = () => setLocked(true);
    onProfileChanged = () => {
      setProfileInput(profileName); loadHistory(); loadPlanPrefs();
      setPlanStartRaw(localStorage.getItem(planKey('start')) || '');
      setPlanLunchRaw(localStorage.getItem(planKey('lunch')) === '1');
      setPlanServingsRaw(parseInt(localStorage.getItem(planKey('servings')) || '2', 10) || 2);
    };
    return () => { onAuthRequired = () => {}; onProfileChanged = () => {}; };
  }, [loadHistory]);

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
            {dataMode === 'demo' ? 'Recipe copy as of 27 Oct 2026 (not live) - saves/history reset on restart' : dataMode === 'pg' ? 'LIVE - your recipe database' : 'LIVE - your Google Sheet'}
          </div>
          <label className="profilebox">Name{' '}
            <input value={profileInput} placeholder="your name (required to save)"
              onChange={(e) => setProfileInput(e.target.value)}
              onBlur={() => setProfileNameGlobal(profileInput)}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }} />
          </label>
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
            {selIngs.length > 0 && (
              <div className="tachips" aria-label="selected ingredients">
                {selIngs.map((v) => (
                  <button key={v} type="button" className="tachip sel" title="remove"
                    onClick={() => setSelIngs(selIngs.filter((x) => x !== v))}>{v}{' ×'}</button>
                ))}
              </div>
            )}
            <label className="muted small" htmlFor="notebox">Ingredients or note</label>
            <input id="notebox" ref={noteInputRef} placeholder="Anything specific? (e.g. no onion, quick, for kids)" value={pnote}
              onChange={(e) => { setPnote(e.target.value); setTaOpen(true); setTaIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setTaOpen(false); return; }
                if (!taOpen || taList.length === 0) return;
                const nav = taNav(e.key, taIndex, taList.length);
                if (!nav) return;
                e.preventDefault();
                if (nav.type === 'move') setTaIndex(nav.index);
                else if (taList[nav.index]) taPick(taList[nav.index]);
              }}
              onBlur={() => setTimeout(() => setTaOpen(false), 150)} />
            {taList.length > 0 && (
              <div className="tachips" role="listbox" aria-label="ingredient suggestions from your library">
                {taList.map((v, i) => (
                  <button key={v} type="button" role="option" aria-selected={i === taIndex}
                    className={'tachip' + (i === taIndex ? ' active' : '')}
                    onMouseDown={(e) => { e.preventDefault(); taPick(v); }}>{v}</button>
                ))}
              </div>
            )}
            {selDishes.length > 0 && (
              <div className="tachips" aria-label="selected dishes">
                {selDishes.map((v) => (
                  <button key={v} type="button" className="tachip sel" title="remove"
                    onClick={() => setSelDishes(selDishes.filter((x) => x !== v))}>{v}{' ×'}</button>
                ))}
              </div>
            )}
            <label className="muted small" htmlFor="dishbox">Dish</label>
            <input id="dishbox" placeholder="Dish name (e.g. ven pongal)" value={dishInput} aria-label="dish filter"
              onChange={(e) => { setDishInput(e.target.value); setDishOpen(true); setDishIndex(0); }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setDishOpen(false); return; }
                if (!dishOpen || dishList.length === 0) return;
                const nav = taNav(e.key, dishIndex, dishList.length);
                if (!nav) return;
                e.preventDefault();
                if (nav.type === 'move') setDishIndex(nav.index);
                else if (dishList[nav.index]) dishPick(dishList[nav.index]);
              }}
              onBlur={() => setTimeout(() => setDishOpen(false), 150)} />
            {dishList.length > 0 && (
              <div className="tachips" role="listbox" aria-label="dish suggestions from your library">
                {dishList.map((v, i) => (
                  <button key={v} type="button" role="option" aria-selected={i === dishIndex}
                    className={'tachip' + (i === dishIndex ? ' active' : '')}
                    onMouseDown={(e) => { e.preventDefault(); dishPick(v); }}>{v}</button>
                ))}
              </div>
            )}
            {dishOpen && dishInput.trim().length >= 2 && dishList.length === 0 && (
              <p className="muted small">No dish in your checked library matches "{dishInput.trim()}".</p>
            )}
            <p className="muted small">Pick one or more dishes - results match any selected dish.</p>
            <div className="cblistwrap">
              <div className="cblisthead">
                <button type="button" className="btn ghost" aria-expanded={showDishList} onClick={() => setShowDishList(!showDishList)}>
                  {showDishList ? 'Hide dish list' : 'Browse dishes'} ({selDishes.length} selected)
                </button>
                {selDishes.length > 0 && <button type="button" className="btn ghost" onClick={() => setSelDishes([])}>Clear all dishes</button>}
              </div>
              {showDishList && (
                <div className="cblist" role="group" aria-label="all dishes in your checked library">
                  {dishVocab.map((v) => (
                    <label key={v} className="cbitem">
                      <input type="checkbox" checked={selDishes.includes(v)} onChange={() => setSelDishes(toggleSel(selDishes, v))} />
                      {v}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="cblistwrap">
              <div className="cblisthead">
                <button type="button" className="btn ghost" aria-expanded={showIngList} onClick={() => setShowIngList(!showIngList)}>
                  {showIngList ? 'Hide ingredient list' : 'Browse ingredients'} ({selIngs.length} selected)
                </button>
                {selIngs.length > 0 && <button type="button" className="btn ghost" onClick={() => setSelIngs([])}>Clear all ingredients</button>}
              </div>
              {showIngList && (
                <div className="cblist" role="group" aria-label="all ingredients in your checked library">
                  {ingVocab.map((v) => (
                    <label key={v} className="cbitem">
                      <input type="checkbox" checked={selIngs.includes(v)} onChange={() => setSelIngs(toggleSel(selIngs, v))} />
                      {v}
                    </label>
                  ))}
                </div>
              )}
            </div>
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

        {(tab === 'recipes' || tab === 'pick' || INDEX_TABS.has(tab)) && <section className="filters" aria-label="result sorting">
          <label>Sort <select aria-label="sort results" value={resultSort} onChange={e=>setResultSort(e.target.value as SortKey)}>
            <option value="original">Original order</option><option value="name">Name A-Z</option>
            {!INDEX_TABS.has(tab) && <><option value="time-asc">Stated cook time: shortest</option><option value="time-desc">Stated cook time: longest</option></>}
            {INDEX_TABS.has(tab) && <><option value="views">Video views: highest</option><option value="newest">Newest published</option></>}
          </select></label>
          {!INDEX_TABS.has(tab) && <label>Time <select aria-label="time filter" value={timeBucket} onChange={e=>setTimeBucket(e.target.value as TimeBucket)}><option value="">All, including unknown</option><option value="quick">Up to 15 minutes</option><option value="mid">15-30 minutes</option><option value="over30">More than 30 minutes</option><option value="unknown">Not stated / unknown</option></select></label>}
          <p className="muted small">{INDEX_TABS.has(tab) ? 'Views are source counts; missing counts sort last. Publish dates come from the source data; videos without a date sort last. Video length is not cook time. The full matching video set is sorted before pagination.' : 'Sorting uses only complete, stated cook times (ranges sort by their upper end); estimates stay unknown and sort last. The time filter uses the stated cook time when there is one, otherwise the video length - video length is not a promised cook time.'} Difficulty and likes are not available in the source data.</p>
          {timeBucket && <p className="muted small">Clear the time filter if no cards appear. A card whose stated time is a range shows in every band the range touches. Cards without a stated cook time are bucketed by video length, not by a promised cook time. The original search and history exclusions are unchanged.</p>}
        </section>}

        {tab === 'recipes' && (
          recipes.length === 0 ? <p className="muted">No checked recipes yet.</p>
            : <div className="grid">{sortedResults(recipes,resultSort,timeBucket,c=>({name:c.name,time:c.time,duration_s:c.duration_s})).map((c) => <RecipeCard key={c.name} c={c} onSaved={loadHistory} />)}</div>
        )}

        {tab === 'pick' && pickResult && (
          <div className="grid">
            {pickForm && (pickForm.note !== pnote || pickForm.diet !== pdiet || pickForm.meal !== pmeal || pickForm.dishes.join(' ') !== selDishes.join(' ') || pickForm.ings.join(' ') !== selIngs.join(' ')) && (
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
                  <button className="btn" onClick={doAskAi} disabled={askAiState === 'sending' || (!pnote.trim() && selIngs.length === 0 && selDishes.length === 0)}>
                    {askAiState === 'sending' ? 'Asking...' : 'Ask about the note above'}
                  </button>
                  {!pnote.trim() && selIngs.length === 0 && selDishes.length === 0 && <p className="muted">Type a note, or pick ingredients or dishes above first.</p>}
                </>
              )}
              {askMode === 'whatsapp' && (
                <a
                  className="btn"
                  href={'https://wa.me/16508702892?text=' + encodeURIComponent(
                    'Meal pick request from my recipe app:\n' +
                    'Diet: ' + (pdiet || 'Veg + Non-veg') + '\n' +
                    'Meal: ' + (pmeal || 'any') +
                    (composedNote() ? '\nNote: ' + composedNote() : '') +
                    (selDishes.length > 0 ? '\nDishes: ' + selDishes.join(', ') : '') +
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
                    {sessionInfo && (
                      <p className="chips">
                        {sessionInfo.continued && <span className="chip">continued conversation</span>}
                        {sessionInfo.diet && <span className="chip">session diet: {sessionInfo.diet}</span>}
                        {sessionInfo.meal && <span className="chip">session meal: {sessionInfo.meal}</span>}
                        <button className="btn ghost" onClick={newConversation} title="Forget this conversation's filters and last ideas">New conversation</button>
                      </p>
                    )}
                    {(askAiResult.question !== pnote.trim() || askAiResult.diet !== pdiet || askAiResult.meal !== pmeal) && (
                      <p className="chips"><span className="chip warn">note/filters changed since this answer - press "Ask about the note above" again</span></p>
                    )}
                    <p style={{ whiteSpace: 'pre-wrap' }}>{askAiResult.text}</p>
                    {sortedResults(askAiResult.recipes,resultSort,timeBucket,p=>({name:p.name,time:p.time,duration_s:(p as any).duration_s})).map((p) => (
                      <div key={p.name} style={{ borderTop: '1px solid #e5e0d8', paddingTop: 8, marginTop: 8 }}>
                        <h3>{p.name}</h3>
                        <Chips diet={p.diet} meal={p.meal} time={p.time} durationS={(p as any).duration_s} />
                        <a className="btn ghost" href={p.url} target="_blank" rel="noopener">Watch video</a>
                      </div>
                    ))}
                    {sortedResults(askAiResult.videos || [],resultSort,timeBucket,v=>({name:v.title,duration_s:(v as any).duration_s})).map((v) => (
                      <div key={v.url} style={{ borderTop: '1px solid #e5e0d8', paddingTop: 8, marginTop: 8 }}>
                        <h3>{v.title}</h3>
                        <p className="chips"><span className="chip warn">{v.status}</span><span className="chip">{v.channel}</span></p>
                        <a className="btn ghost" href={v.url} target="_blank" rel="noopener">Watch video</a>
                      </div>
                    ))}
                    <p className="muted">AI suggestion, not a nutrition, allergy or safety guarantee.</p>
                    {semanticInfo && (
                      <p className="muted small">Meaning layer: {semanticInfo.available ? 'ready (local model, nothing sent out for matching)' : (semanticInfo.reason === 'loading' ? 'loading on this server - standard word rules used meanwhile' : 'not active' + (semanticInfo.reason ? ' (' + semanticInfo.reason + ')' : '') + ' - standard word rules in use')}</p>
                    )}
                  </div>
                </div>
              )}
              {askAiState === 'error' && <p className="muted">{askAiError}</p>}
            </div>
            {pickResult.usedAI && (
              <p className="muted span-all">Reasons are AI taste suggestions, not nutrition, allergy or safety guarantees.</p>
            )}
            {sortedResults([...pickResult.picks,...extraPicks],resultSort,timeBucket,p=>({name:p.name,time:p.time,duration_s:(p as any).duration_s})).map((p) => (
              <article className="card" key={p.name}>
                <a className="thumb" href={p.url} target="_blank" rel="noopener">
                  <img src={thumb(p.url)} loading="lazy" alt="" />
                  <span className="play">▶</span>
                </a>
                <div className="cardbody">
                  <h3>{p.name}</h3>
                  <Chips diet={p.diet} meal={p.meal} time={p.time} durationS={(p as any).duration_s} />
                  {p.reason && <p>{p.reason}</p>}
                  <a className="btn ghost" href={p.url} target="_blank" rel="noopener">Watch video</a>
                  <ActionButtons id={videoId(p.url)} title={p.name} onSaved={loadHistory} />
                </div>
              </article>
            ))}
            {!timeBucket && (pickResult.videos || []).length > 0 && (
              <p className="muted span-all">Only {pickResult.picks.length} checked {pickResult.picks.length === 1 ? 'recipe matches' : 'recipes match'}. Videos below are full-library matches whose ingredients and steps are not extracted yet:</p>
            )}
            {sortedResults(pickResult.videos || [],resultSort,timeBucket,v=>({name:v.title,duration_s:(v as any).duration_s})).map((v) => (
              <article className="card" key={v.video_id}>
                <a className="thumb" href={v.url} target="_blank" rel="noopener">
                  <img src={thumb(v.url)} loading="lazy" alt="" />
                  <span className="play">▶</span>
                </a>
                <div className="cardbody">
                  <h3>{v.title}</h3>
                  <p className="muted small">{v.channel}{v.diet ? ' · ' + v.diet : ''}</p>
                  <p className="muted small">{v.status}</p>
                  <a className="btn ghost" href={v.url} target="_blank" rel="noopener">Watch video</a>
                </div>
              </article>
            ))}
            {sortedResults(extraVideos,resultSort,timeBucket,v=>({name:v.title,duration_s:(v as any).duration_s})).map((v) => (
              <article className="card" key={v.video_id}>
                <a className="thumb" href={v.url} target="_blank" rel="noopener">
                  <img src={thumb(v.url)} loading="lazy" alt="" />
                  <span className="play">▶</span>
                </a>
                <div className="cardbody">
                  <h3>{v.title}</h3>
                  <p className="muted small">{v.channel}{v.diet ? ' · ' + v.diet : ''}</p>
                  <p className="muted small">{v.status}</p>
                  <a className="btn ghost" href={v.url} target="_blank" rel="noopener">Watch video</a>
                </div>
              </article>
            ))}
            {moreState === 'exhausted' ? (
              <p className="muted span-all">No more matching recipes or videos for this search.</p>
            ) : (pickResult.count > 0 || (pickResult.videos || []).length > 0 || extraPicks.length + extraVideos.length > 0) && (
              <button className="btn ghost span-all" onClick={doLoadMore} disabled={moreState === 'loading'}>
                {moreState === 'loading' ? 'Loading...' : 'Load more'}
              </button>
            )}
          </div>
        )}

        {INDEX_TABS.has(tab) && videos !== null && (
          <p className="muted small seccount" aria-live="polite">
            {videoTotal === 0 ? 'No videos match the current filters.'
              : <>Showing {(videoPage - 1) * videoPageSize + 1}-{Math.min(videoPage * videoPageSize, videoTotal)} of {videoTotal.toLocaleString()} matching videos{videoPages > 1 ? ` - page ${videoPage} of ${videoPages}` : ''}.</>}
          </p>
        )}
        {INDEX_TABS.has(tab) && (
          videos === null ? <p className="muted">Loading...</p>
            : videos.length === 0 ? <p className="muted">No videos match. Clear search or filters.</p>
            : sortedResults(videos,resultSort,'',v=>({name:v.title,views:v.views,published:v.published})).map((v) => (
              <article className="row" key={v.id}>
                <a className="rowthumb" href={v.url} target="_blank" rel="noopener"><img src={v.thumb} loading="lazy" alt="" /></a>
                <div className="rowbody">
                  <a className="rowtitle" href={v.url} target="_blank" rel="noopener">{v.title}</a>
                  <div className="muted small">{v.channel}{v.published ? ', ' + v.published : ''}</div>
                  <div className="rowmeta">
                    <span className="chip">{v.category}</span><span className="chip">Views: {v.views || 'not stated'}</span>
                    <span className="chip">{v.diet}</span>
                    {v.status === 'raw-extracted' && <span className="chip">details captured</span>}
                  </div>
                  <ActionButtons id={v.id} title={v.title} onSaved={loadHistory} />
                </div>
              </article>
            ))
        )}

        {INDEX_TABS.has(tab) && videos !== null && videoTotal > 0 && (
          <nav className="pager" aria-label="video pages">
            <button className="btn ghost" disabled={videoPage <= 1} onClick={() => setVideoPage(videoPage - 1)}>Previous</button>
            <span className="pager-nums">
              {(() => {
                const nums: number[] = [];
                const around = 2;
                const lo = Math.max(1, videoPage - around), hi = Math.min(videoPages, videoPage + around);
                if (lo > 1) nums.push(1);
                if (lo > 2) nums.push(-1);
                for (let n = lo; n <= hi; n++) nums.push(n);
                if (hi < videoPages - 1) nums.push(-1);
                if (hi < videoPages) nums.push(videoPages);
                return nums.map((n, i) => n === -1
                  ? <span key={'e' + i} className="muted"> ... </span>
                  : <button key={n} className={'btn ghost pagenum' + (n === videoPage ? ' on' : '')} aria-current={n === videoPage ? 'page' : undefined} onClick={() => setVideoPage(n)}>{n}</button>);
              })()}
            </span>
            <button className="btn ghost" disabled={videoPage >= videoPages} onClick={() => setVideoPage(videoPage + 1)}>Next</button>
            <label className="muted small">Per page <select aria-label="videos per page" value={videoPageSize} onChange={(e) => { setVideoPageSize(parseInt(e.target.value, 10)); setVideoPage(1); }}>
              <option value={50}>50</option><option value={100}>100</option><option value={200}>200</option>
            </select></label>
          </nav>
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

        {tab === 'plan' && (
          <section className="panel">
            <h2>30-day plan</h2>
            <p className="plan-sample-note">Sample menu - not personalized. Dietary needs, allergies and who is eating are not confirmed yet; the dates, lunch pattern and servings below are editable.</p>
            <div className="plan-controls">
              <label>Start date <input type="date" value={planStart} onChange={(e) => setPlanStart(e.target.value)} /></label>
              <label><input type="checkbox" checked={planLunch} onChange={(e) => setPlanLunch(e.target.checked)} /> Lunch every day</label>
              <label>Servings (sample) <input type="number" min={1} max={10} value={planServings} onChange={(e) => setPlanServings(parseInt(e.target.value) || 2)} /></label>
            </div>
            {!plan && <p className="muted">Building plan...</p>}
            {plan && plan.error && <p className="muted">Plan could not be generated right now.</p>}
            {plan && !plan.error && (<>
              <details className="plan-assumptions"><summary>How this plan and its nutrition estimates work</summary>
                <ul>{(plan.assumptions || []).map((a: string, i: number) => <li key={i}>{a}</li>)}</ul>
                <p className="muted">{plan.source_note}</p>
              </details>
              {plan.days_plan.map((d: any, di: number) => (
                <details key={d.date} className="plan-day" open={di === 0}>
                  <summary className="plan-day-summary">
                    <span className="plan-day-title">{d.weekday}, {d.date}</span>
                    <span className="plan-day-compact muted">{d.slots.map((s: any) => (s.recipe ? s.recipe.name : null)).filter(Boolean).join(' · ')}</span>
                  </summary>
                  <ul>
                    {d.slots.map((s: any) => (
                      <li key={s.slot} className="plan-slot">
                        <span className="plan-slot-name">{s.slot}</span>
                        {s.recipe ? (<>
                          {thumb(s.recipe.url) && <img className="plan-thumb" src={thumb(s.recipe.url)} alt="" loading="lazy" />}
                          <span className="plan-slot-body">
                            <a href={s.recipe.url} target="_blank" rel="noreferrer">{s.recipe.name}</a>
                            {s.recipe.partial && <span className="muted"> (partial)</span>}
                            <span className="muted"> image: video preview, not a verified dish photo</span>
                            {s.recipe.composition === 'side_only' && s.recipe.staple_suggestion && <span className="muted"> - side dish; {s.recipe.staple_suggestion.text} (standard portion proposal)</span>}
                            {' '}
                            {s.recipe.nutrition && s.recipe.nutrition.eligible && s.recipe.nutrition_per_portion ? (
                              <span className="plan-nutrition">
                                <span className="plan-nutrition-batch"><b>Whole recipe batch:</b> {s.recipe.nutrition.kcal.toLocaleString()} kcal - protein {s.recipe.nutrition.protein_g}g, fat {s.recipe.nutrition.fat_g}g, carbs {s.recipe.nutrition.carb_g}g, fibre {s.recipe.nutrition.fibre_g}g</span>
                                <span className="plan-nutrition-portion"><b>Per portion</b> ({s.recipe.portion_assumption}): ~{s.recipe.nutrition_per_portion.kcal.toLocaleString()} kcal - protein {s.recipe.nutrition_per_portion.protein_g}g, fat {s.recipe.nutrition_per_portion.fat_g}g, carbs {s.recipe.nutrition_per_portion.carb_g}g, fibre {s.recipe.nutrition_per_portion.fibre_g}g</span>
                                {s.recipe.nutrition.notes && s.recipe.nutrition.notes.length > 0 && <span className="muted small"> ({s.recipe.nutrition.notes.join('; ')})</span>}
                                {s.recipe.nutrition.approx_used && <span className="muted small"> (includes standard-reference values for oil/butter/sugar where the source names the ingredient but not the brand)</span>}
                              </span>
                            ) : (
                              <span className="muted">nutrition not shown - {s.recipe.nutrition && s.recipe.nutrition.ineligible_reasons && s.recipe.nutrition.ineligible_reasons.length > 0 ? s.recipe.nutrition.ineligible_reasons[0] : 'source is missing critical quantities'}</span>
                            )}
                            {s.recipe.ingredients && s.recipe.ingredients.length > 0 && (
                              <details className="plan-ing"><summary>Ingredients (as stated in source)</summary>
                                <ul>{s.recipe.ingredients.map((line: string, i: number) => <li key={i}>{line}</li>)}</ul>
                              </details>
                            )}
                          </span>
                        </>) : <span className="muted">no extracted card for this slot yet</span>}
                        {s.video_refs.length > 0 && (
                          <span className="plan-vref"> or see video: {s.video_refs.map((v: any, i: number) => (
                            <a key={i} href={v.url} target="_blank" rel="noreferrer">{v.title}</a>
                          )).reduce((prev: any, curr: any) => [prev, ', ', curr])} <span className="muted">(reference only - not extracted)</span></span>
                        )}
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </>)}
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
