/**
 * Pick logic - single source of truth, shared by the API and the unit tests.
 *
 * Rules (ported 1:1 from the Apps Script version):
 * - picks come ONLY from verified recipes (verified === 'yes'; 'partial' rows
 *   with approximate quantities are shown in the library but never picked)
 * - 30-day no-repeat: any video suggested or cooked in the last 30 days is out
 * - diet filters are conservative: 'Veg' is strict, 'Non-veg' needs an
 *   explicit egg/meat classification, unknown diets match neither filter
 * - one idea per video: a dish and its side (Pongal + Gotsu) never take 2 slots
 * - at most 5 picks; if fewer qualify, say so honestly - no filler
 * - AI ranking is opt-in and only re-orders/annotates candidates; the
 *   exclusion above always happens here, never in the model
 */

export interface RecipeRow {
  recipe_name: string;
  video_url: string;
  channel?: string;
  diet?: string;
  meal_type?: string;
  time_notes?: string;
  ingredients?: string;
  verified?: string;
}

/**
 * Diet classification. Recipes carry an explicit confirmed diet string
 * ('Veg', 'Egg', 'Contains egg', 'Non-veg', ...). Anything else - blank,
 * unrecognized, '?' - is UNKNOWN and must never be silently treated as
 * non-veg (or veg). Title-derived hints live on the video index only and
 * are a separate, weaker signal; the picker never uses them.
 */
const NONVEG_RE = /egg|non-?veg|chicken|mutton|fish|prawn|shrimp|crab|meat|beef|pork/i;
export function dietClass(diet?: string): 'veg' | 'nonveg' | 'veg-conditional' | 'unknown' {
  const s = String(diet || '').trim().toLowerCase();
  if (s === 'veg' || s === 'vegetarian') return 'veg';
  // "Veg (needs eggless mayo dip)" style: plant-based ONLY with a stated
  // adaptation. Not a plain-Veg pick (the egg risk is real), not Non-veg
  // either - shown unfiltered and offerable by the AI with its caveat.
  if (/^veg\b.*\(.+\)/.test(s)) return 'veg-conditional';
  if (NONVEG_RE.test(s)) return 'nonveg';
  return 'unknown';
}

/**
 * Free-text pick note when AI ranking is OFF. The note is applied ONLY by
 * conservative keyword rules, and the result says exactly what happened:
 *  - "no X" / "without X" / "avoid X" -> hard-exclude recipes whose name or
 *    ingredient list contains X
 *  - other plain words -> HARD requirement: only recipes whose name or
 *    ingredient list contains the word (whole-word, so 'breadless' does
 *    NOT satisfy 'bread') qualify. If none do, the result is an honest
 *    zero, never unrelated filler.
 * A note we cannot parse into keywords is ignored and reported as ignored.
 * No semantic claims are made - that needs the opt-in AI ranker.
 */
const NOTE_STOP = new Set(('the a an and or for with without something anything me my we us our please want using use make ' +
  'like love make made dish dishes recipe recipes food some that this these those today tonight kids kid ' +
  'friendly style type eat eating have get give show pick ideas idea will would shall should can could ' +
  'may might must just really very also still even ever never any every too yet').split(' '));

export function wordRe(term: string): RegExp {
  return new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i');
}

// Canonical-ingredient identity: a DERIVED form of an ingredient is not the
// ingredient itself - but ONLY where we have grounded evidence of the
// confusion, not as a global assumption. Grounded case (2026-10-26 defect):
// "corn starch/flour/syrup/oil" (spaced or hyphenated) are corn products,
// and a potato chip listing corn starch is not an answer to "corn".
// Other ingredients keep literal matching until a similar case is evidenced
// (e.g. atta/wheat flour may well BE intended by "wheat" - unverified).
const DERIVED_FORMS: Record<string, string[]> = {
  corn: ['starch', 'flour', 'syrup', 'oil', 'meal']
};
export function hasIngredientWord(hay: string, term: string): boolean {
  if (!wordRe(term).test(hay)) return false;
  const derived = DERIVED_FORMS[term];
  if (!derived) return true;
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = '(?:' + derived.join('|') + ')s?';
  const stripped = hay.replace(new RegExp('\\b' + esc + '\\s*[- ]\\s*' + suffix + '\\b', 'gi'), ' ');
  return wordRe(term).test(stripped);
}

// ---- bounded typo tolerance for note words ----
// Source-backed spelling variants seen in Indian-English recipe writing.
const NOTE_ALIASES: Record<string, string> = {
  panner: 'paneer',
  panir: 'paneer',
};

function editDistanceLe1(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let diff = 0;
    for (let i = 0; i < la; i++) if (a[i] !== b[i] && ++diff > 1) return false;
    return diff === 1;
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

/** Food words the verified library actually mentions (names + ingredients). */
export function noteVocab(recipes: RecipeRow[]): string[] {
  const words = new Set<string>();
  for (const r of recipes) {
    if (String(r.verified).toLowerCase() !== 'yes') continue;
    const text = (String(r.recipe_name) + ' ' + String(r.ingredients || '')).toLowerCase();
    for (const w of text.split(/[^a-z]+/)) {
      if (w.length >= 4 && !NOTE_STOP.has(w)) words.add(w);
    }
  }
  return [...words];
}

/** Words from the INGREDIENTS column only: membership here marks a true
 * ingredient, which a classifier 'mood' label can never demote. */
export function ingredientVocab(recipes: RecipeRow[]): string[] {
  const words = new Set<string>();
  for (const r of recipes) {
    if (String(r.verified).toLowerCase() !== 'yes') continue;
    for (const w of String(r.ingredients || '').toLowerCase().split(/[^a-z]+/)) {
      if (w.length >= 4 && !NOTE_STOP.has(w)) words.add(w);
    }
  }
  return [...words];
}

export interface NoteInterpretation { from: string; to: string; }

// Normalizes one note word to a library word only when the match is
// unambiguous: a source-backed alias, or exactly one edit-distance-1 library
// word with the same first letter. Ambiguous or unknown words stay as
// written - the honest no-match path resolves them, never a guess. A
// normalized word is still a HARD constraint; matching never relaxes.
export function normalizeNoteWord(word: string, vocab: string[]): { word: string; interpreted?: NoteInterpretation } {
  const w = String(word || '').toLowerCase();
  if (NOTE_ALIASES[w]) return { word: NOTE_ALIASES[w], interpreted: { from: word, to: NOTE_ALIASES[w] } };
  if (w.length < 4 || vocab.indexOf(w) !== -1) return { word };
  // A question or request word is never a typo for an ingredient ("what" is
  // not "wheat"): the edit-distance guess must not run on them.
  if (ASK_REQUEST_WORDS.has(w) || NOTE_STOP.has(w)) return { word };
  const cand = vocab.filter((v) => v[0] === w[0] && editDistanceLe1(w, v));
  if (cand.length === 1) return { word: cand[0], interpreted: { from: word, to: cand[0] } };
  return { word };
}

export function normalizeNoteWords(words: string[], vocab: string[]): { words: string[]; interpreted: NoteInterpretation[]; pairs: { orig: string; word: string; interpreted?: NoteInterpretation }[] } {
  const interpreted: NoteInterpretation[] = [];
  const pairs = words.map((orig) => {
    const n = normalizeNoteWord(orig, vocab);
    if (n.interpreted) interpreted.push(n.interpreted);
    return { orig, word: n.word, interpreted: n.interpreted };
  });
  return { words: [...new Set(pairs.map((p) => p.word))], interpreted, pairs };
}

function coverageNote(label: string, words: string[], pool: RecipeRow[]): string {
  const counts = words.map((k) => {
    const re = wordRe(k);
    return pool.filter((r) => re.test(r.recipe_name + ' ' + (r.ingredients || ''))).length + ' list "' + k + '"';
  });
  return 'checked ' + pool.length + ' verified ' + label + ' recipes: ' + (counts.length ? counts.join(', ') : 'no note words to check');
}

export function parseNote(note: string): { exclusions: string[]; keywords: string[] } {
  const exclusions: string[] = [];
  let rest = ' ' + String(note || '').toLowerCase().replace(/[,;!?]/g, '.').replace(/[^a-z\s.-]/g, ' ') + ' ';
  const exRe = /\b(?:no|without|avoid)\s+([a-z][a-z -]{0,40}?)(?=\s*(?:,|\.|$))/g;
  let m: RegExpExecArray | null;
  const spans: [number, number][] = [];
  while ((m = exRe.exec(rest)) !== null) {
    for (const part of m[1].split(/\s+(?:and|or)\s+/)) {
      const t = part.trim();
      if (t && t.length >= 3 && !NOTE_STOP.has(t)) exclusions.push(t);
    }
    spans.push([m.index, m.index + m[0].length]);
  }
  for (const [a, b] of spans) rest = rest.slice(0, a) + ' '.repeat(b - a) + rest.slice(b);
  const keywords = [...new Set(rest.split(/[^a-z-]+/)
    .filter((w) => w.length >= 3 && !NOTE_STOP.has(w)))].slice(0, 6);
  return { exclusions: [...new Set(exclusions)].slice(0, 6), keywords };
}

export interface PickFilter { diet?: string; meal?: string; }

// Words that describe the request itself, never an ingredient - excluded
// from the food-word hard filter in ask mode.
const ASK_REQUEST_WORDS = new Set(('breakfast lunch dinner snack snacks sweet sweets sunday meal meals ' +
  'recipe recipes dish dishes food cook cooking make idea ideas quick easy today tonight tomorrow week weekday weekend ' +
  'which what who whom whose when where why how do does did me my we our us you your have has had any some show give list tell ' +
  'is are was were be been the in on for of to at by with without and or not no can could should would will please get got ' +
  'something anything everything veg veggie vegetarian non-veg nonveg').split(' '));

// Inventory/direct lookups about the library itself ("which bread recipes do
// I have?", "how do I make X?", "list my chutneys") are not recommendation
// requests: the 30-day no-repeat, an anti-repetition rule for NEW
// suggestions, must not hide owned recipes from an answer about what the
// cook already has. (Implementation judgment: the user's stated intent is
// avoiding repeat meals, not hiding their inventory.)
const LOOKUP_RE = /\b(?:do i have|do we have|which [a-z -]{0,40}have|what [a-z -]{0,40}have|list|show me|how (?:do i|to) (?:make|cook)|recipe for|steps for|ingredients for|tell me about)/i;
export function isLookupQuestion(question: string): boolean {
  return LOOKUP_RE.test(String(question || ''));
}

// The ask-ai route's hard constraints, mirroring pick rules:
//  - "no X" / "without X" exclusions are ALWAYS hard
//  - recently suggested/cooked recipes (30-day no-repeat) stay hidden UNLESS
//    the question names that dish directly (a direct question must still be
//    answerable)
//  - words the classifier explicitly calls FOOD are hard requirements:
//    matching candidates only, or an honest zero - never an invented answer
export function constrainAskCandidates(
  candidates: RecipeRow[],
  question: string,
  excluded: AskExclusions,
  classification: Record<string, string>,
  vocab?: string[],
  allVerified?: RecipeRow[]
): { candidates: RecipeRow[]; zeroReason?: string; interpreted: NoteInterpretation[] } {
  const parsed = parseNote(question);
  const v = vocab || noteVocab(candidates);
  const exN = normalizeNoteWords(parsed.exclusions, v);
  const kwN = normalizeNoteWords(parsed.keywords, v);
  const interpreted = [...exN.interpreted, ...kwN.interpreted];
  let out = candidates;
  if (exN.words.length > 0) {
    out = out.filter((r) => {
      const hay = r.recipe_name + ' ' + (r.ingredients || '');
      return !exN.words.some((x) => wordRe(x).test(hay));
    });
  }
  const afterNoteExclusions = out;
  const noRepeatRan = !isLookupQuestion(question);
  const q = question.toLowerCase();
  const shortOf = (s: string) => String(s || '').split('(')[0].trim().toLowerCase();
  if (noRepeatRan) out = out.filter((r) => {
    const short = shortOf(r.recipe_name);
    if (short.length >= 4 && q.indexOf(short) !== -1) return true; // asked about by name: always answerable
    const id = videoIdOf(r.video_url);
    if (excluded.videoOnly[id]) return false;
    return !(excluded.titles[id] || []).some((t) => {
      const ts = shortOf(t);
      return ts.length >= 4 && (ts === short || short.startsWith(ts) || ts.startsWith(short));
    });
  });
  // A library word is an ingredient constraint UNLESS the classifier
  // deliberately called it a mood: a classifier FAILURE (empty/unknown)
  // can never silently drop the hard filter, but an explicit 'mood' still
  // demotes dish-type words ("which chutney recipes do I have?").
  // Membership is checked against the WIDE library vocabulary, not the
  // already-filtered pool - "paneer" is paneer even when the snack pool
  // has none.
  const wideV = allVerified && allVerified.length ? noteVocab(allVerified) : v;
  const wideIng = allVerified && allVerified.length ? ingredientVocab(allVerified) : [];
  const foodWords = kwN.pairs
    .filter((p) => (classification[p.orig] === 'food' || p.interpreted || wideIng.includes(p.word) || (wideV.includes(p.word) && classification[p.orig] !== 'mood')) && !ASK_REQUEST_WORDS.has(p.word))
    .map((p) => p.word);
  if (foodWords.length > 0) {
    const hayOf = (r: RecipeRow) => r.recipe_name + ' ' + (r.ingredients || '');
    // Multiple food words are an AND: "onion paneer" means recipes with
    // BOTH, never a silent OR that shows onion-only or paneer-only dishes.
    const hasEvery = (r: RecipeRow) => foodWords.every((k) => hasIngredientWord(hayOf(r), k));
    const matched = out.filter(hasEvery);
    if (matched.length === 0) {
      // Stage the pool so the reason names the REAL cause with deterministic
      // counts - library-wide absence vs diet/meal filters vs the note's own
      // exclusions vs the 30-day no-repeat - never a model guess. The stages
      // are sequential filters, so each recipe is counted at the first stage
      // that drops it.
      const pool = allVerified && allVerified.length ? allVerified : candidates;
      const inLibrary = pool.filter(hasEvery);
      const keyOf = (r: RecipeRow) => String(r.video_url || '') + '|' + r.recipe_name;
      const minus = (a: RecipeRow[], b: RecipeRow[]) => { const s = new Set(b.map(keyOf)); return a.filter((r) => !s.has(keyOf(r))); };
      const fmtList = (rs: RecipeRow[]) => rs.slice(0, 3).map((r) => r.recipe_name).join('; ') + (rs.length > 3 ? '; ...' : '');
      let reason: string;
      if (inLibrary.length === 0) {
        reason = 'No verified recipe matches everything - ' + coverageNote('library', foodWords, pool) +
          (interpreted.length > 0 ? '; interpreted ' + interpreted.map((i) => '"' + i.from + '" as "' + i.to + '"').join(', ') : '') +
          '. Nothing invented to fill the gap - a gap in the checked library, not proof the dish does not exist.';
      } else {
        const afterDietMeal = candidates.filter(hasEvery);
        const dietMealDropped = minus(inLibrary, afterDietMeal);
        const exDropped = minus(afterDietMeal, afterNoteExclusions.filter(hasEvery));
        const repeatDropped = noRepeatRan ? afterNoteExclusions.filter(hasEvery) : [];
        const causes: string[] = [];
        if (repeatDropped.length > 0) causes.push(repeatDropped.length + ' checked ' + (repeatDropped.length === 1 ? 'recipe was' : 'recipes were') + ' already suggested within the last 30 days, so the no-repeat rule hides ' + (repeatDropped.length === 1 ? 'it' : 'them') + ' (' + fmtList(repeatDropped) + ') - ask for one by name to see it again');
        if (dietMealDropped.length > 0) causes.push(dietMealDropped.length + ' ' + (dietMealDropped.length === 1 ? 'sits' : 'sit') + ' outside your current diet/meal filters (' + fmtList(dietMealDropped) + ') - loosen a filter to see ' + (dietMealDropped.length === 1 ? 'it' : 'them'));
        if (exDropped.length > 0) causes.push(exDropped.length + ' removed by your own exclusion note (' + fmtList(exDropped) + ')');
        reason = 'No verified recipe left for ' + foodWords.map((k) => '"' + k + '"').join(' + ') + ': ' +
          (causes.length > 0 ? causes.join('; ') : 'the checked library has ' + inLibrary.length + ' (' + fmtList(inLibrary) + ') but every one was constrained out') +
          '. Nothing invented to fill the gap.';
      }
      return { candidates: [], interpreted, zeroReason: reason };
    }
    out = matched;
  }
  return { candidates: out, interpreted };
}

// The single source of truth for "which recipes may be shown under these
// filters": verified-only, conservative diet rules ('Veg' strict; 'Non-veg'
// needs an explicit egg/meat classification; unknown diets match NEITHER
// filter and only appear unfiltered), substring meal match. Every
// user-facing route (picks AND free-form AI answers) must go through this -
// never re-implement the rules at a call site.
export function filterCandidateRecipes(recipes: RecipeRow[], filter?: PickFilter): RecipeRow[] {
  return recipes.filter((r) => {
    if (String(r.verified).toLowerCase() !== 'yes') return false;
    const dc = dietClass(r.diet);
    if (filter && filter.diet === 'Veg' && dc !== 'veg') return false;
    if (filter && filter.diet === 'Non-veg' && dc !== 'nonveg') return false;
    if (filter && filter.diet && filter.diet !== 'Veg' && filter.diet !== 'Non-veg' && r.diet !== filter.diet) return false;
    if (filter && filter.meal && String(r.meal_type || '').toLowerCase().indexOf(filter.meal.toLowerCase()) === -1) return false;
    return true;
  });
}

export interface PickResult {
  count: number;
  usedAI: boolean;
  note: string;
  noteInfo: string;
  interpreted?: NoteInterpretation[];
  picks: { name: string; url: string; time: string; diet: string; meal: string; reason: string }[];
  ids: string[];
}

export function videoIdOf(url: string): string {
  const m = String(url || '').match(/v=([\w-]{11})/);
  return m ? m[1] : '';
}

export function excludedIds(history: any[], picks: any[], now = new Date()): Record<string, true> {
  const cut = new Date(now); cut.setDate(cut.getDate() - 30);
  const ex: Record<string, true> = {};
  for (const r of history || []) {
    if (r.state !== 'suggested' && r.state !== 'cooked') continue;
    if (new Date(r.date) >= cut && r.video_id) ex[String(r.video_id)] = true;
  }
  for (const r of picks || []) {
    if (new Date(r.date) < cut) continue;
    for (const id of String(r.suggested_video_ids || '').split(',')) {
      const t = id.trim(); if (t) ex[t] = true;
    }
  }
  return ex;
}

// Ask-route no-repeat, dish-aware: a history row records WHICH dish was
// suggested/cooked (video + title), so sibling dishes from the same video
// stay answerable - one-idea-per-video is pick dedupe ONLY. Pick rows store
// video ids without dish names, so those entries conservatively hide the
// whole video (one of its dishes was shown; we cannot tell which).
export interface AskExclusions { titles: Record<string, string[]>; videoOnly: Record<string, true>; }

export function excludedForAsk(history: any[], picks: any[], now = new Date()): AskExclusions {
  const cut = new Date(now); cut.setDate(cut.getDate() - 30);
  const titles: Record<string, string[]> = {};
  const videoOnly: Record<string, true> = {};
  for (const r of history || []) {
    if (r.state !== 'suggested' && r.state !== 'cooked') continue;
    if (!(new Date(r.date) >= cut) || !r.video_id) continue;
    const v = String(r.video_id);
    const t = String(r.title || '').trim();
    if (t) (titles[v] = titles[v] || []).push(t);
    else videoOnly[v] = true;
  }
  for (const r of picks || []) {
    if (new Date(r.date) < cut) continue;
    for (const id of String(r.suggested_video_ids || '').split(',')) {
      const t = id.trim(); if (t) videoOnly[t] = true;
    }
  }
  return { titles, videoOnly };
}

export type RankFn = (candidates: RecipeRow[], filter: PickFilter, note: string)
  => Promise<{ order: number[]; reasons: Record<number, string> }>;

// Classifies unmatched note words: 'food' = ingredient, dish, cuisine,
// allergen, drink (a HARD requirement - no match means an honest zero,
// never an unrelated "close enough" fallback); 'mood' = a soft preference
// (light, quick, spicy, kid-friendly) the ranker may interpret by meaning.
export type ClassifyFn = (words: string[]) => Promise<Record<string, 'food' | 'mood' | 'unknown'>>;

export async function pickForMe(
  filter: PickFilter,
  note: string,
  recipes: RecipeRow[],
  excluded: Record<string, true>,
  rankFn?: RankFn,
  classifyFn?: ClassifyFn,
  slimFn?: ((candidates: RecipeRow[]) => Promise<RecipeRow[] | null>) | null,
  seenIds?: Record<string, true>
): Promise<PickResult> {
  let blockedByHistory = 0;
  let blockedBySeen = 0;
  let candidates = filterCandidateRecipes(recipes, filter).filter((r) => {
    const id = videoIdOf(r.video_url);
    if (excluded[id]) { blockedByHistory++; return false; }
    if (seenIds && seenIds[id]) { blockedBySeen++; return false; }
    return true;
  });
  // One idea per video.
  const seen: Record<string, true> = {};
  candidates = candidates.filter((r) => {
    const id = videoIdOf(r.video_url) || r.recipe_name;
    if (seen[id]) return false;
    seen[id] = true; return true;
  });

  // Without AI ranking, choose at random among eligible recipes on every
  // request. Each shown set is recorded as 'suggested' and excluded for 30
  // days, so re-tapping always returns a fresh set, never the same ideas.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  let usedAI = false;
  let noteInfo = '';
  let noteZeroMatch = false;
  const parsed = note && note.trim() ? parseNote(note) : { exclusions: [] as string[], keywords: [] as string[] };
  const vocab = noteVocab(recipes);
  const exN = normalizeNoteWords(parsed.exclusions, vocab);
  const kwN = normalizeNoteWords(parsed.keywords, vocab);
  const interpreted = [...exN.interpreted, ...kwN.interpreted];
  const parts: string[] = [];
  if (interpreted.length > 0) {
    parts.push('interpreted ' + interpreted.map((i) => '"' + i.from + '" as "' + i.to + '"').join(', '));
  }
  if (exN.words.length > 0) {
    candidates = candidates.filter((r) => {
      const hay = r.recipe_name + ' ' + (r.ingredients || '');
      return !exN.words.some((x) => wordRe(x).test(hay));
    });
    parts.push('excluded recipes containing ' + exN.words.map((x) => '"' + x + '"').join(', '));
  }
  if (kwN.words.length > 0) {
    // Library words (a known ingredient/dish word, or an unambiguous
    // interpretation of one) are HARD requirements and combine as AND:
    // "onion paneer" means a recipe with BOTH, never a silent OR. Words the
    // library does not know (wishes like "quick") stay out of the hard
    // filter - the ranking/meaning path below handles them. AI ranking, when
    // on, only re-orders whatever survives this filter.
    const hard = [...new Set(kwN.pairs.filter((p) => p.interpreted || vocab.indexOf(p.word) !== -1).map((p) => p.word))];
    const req = hard.length > 0 ? hard : kwN.words;
    const matched = candidates.filter((r) => {
      const hay = r.recipe_name + ' ' + (r.ingredients || '');
      return hard.length > 0 ? req.every((k) => hasIngredientWord(hay, k)) : req.some((k) => hasIngredientWord(hay, k));
    });
    if (matched.length > 0) {
      candidates = matched;
      parts.push('showing only recipes whose name or ingredients match ' + (req.length > 1 ? 'every one of ' : '') + req.map((k) => '"' + k + '"').join(', '));
    } else if (rankFn) {
      // A word nothing mentions literally may only become a soft
      // ranked-by-meaning wish when the classifier says it is clearly a
      // mood/preference. Foods, dishes, cuisines, allergens - and any word
      // the classifier cannot place or fails on - stay HARD requirements:
      // no match means an honest zero, never an unrelated fallback.
      let allMood = false;
      if (classifyFn) {
        try {
          const cls = await classifyFn(req);
          allMood = req.every((k) => cls[k] === 'mood');
        } catch { allMood = false; }
      }
      if (allMood) {
        parts.push('no recipe name or ingredient mentions ' + req.map((k) => '"' + k + '"').join(', ') + ' directly, so the note was ranked by meaning');
      } else {
        const coverage = coverageNote([filter.diet, filter.meal].filter(Boolean).join(' ') || 'unfiltered', req, candidates);
        candidates = [];
        noteZeroMatch = true;
        parts.push('no verified recipe matches everything - ' + coverage + '. Nothing filled in; this is a gap in the checked library, not proof the dish does not exist');
      }
    } else {
      const coverage = coverageNote([filter.diet, filter.meal].filter(Boolean).join(' ') || 'unfiltered', req, candidates);
      candidates = [];
      noteZeroMatch = true;
      parts.push('no verified recipe matches everything - ' + coverage + '. Nothing filled in; this is a gap in the checked library, not proof the dish does not exist');
    }
  }
  if (note && note.trim() && !rankFn) {
    noteInfo = parts.length > 0
      ? 'Your note was applied with simple keyword matching (AI ranking is off): ' + parts.join('; ') + '.'
      : 'Your note ("' + note.trim().slice(0, 60) + '") could not be applied - free-text wishes need AI ranking, which is off. Picks below are standard unranked matches.';
  } else if (note && note.trim() && parts.length > 0) {
    noteInfo = 'Note constraints applied before ranking: ' + parts.join('; ') + '.';
  }
  // Meaning-aware slim AFTER every hard constraint, BEFORE the AI rank: the
  // model sees the ~12 most relevant candidates instead of the whole pool -
  // smaller prompt, fewer tokens. A slim failure (embeddings unavailable)
  // keeps the full pool; nothing is blocked by it.
  if (slimFn && candidates.length > 12) {
    try { const slim = await slimFn(candidates); if (slim && slim.length) candidates = slim; } catch { /* keep full pool */ }
  }
  let chosen = candidates.slice(0, 5);
  if (rankFn && candidates.length > 0) {
    try {
      const { order, reasons } = await rankFn(candidates, filter, note);
      const valid = order.filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length);
      const uniq = [...new Set(valid)].slice(0, 5);
      if (uniq.length > 0) {
        chosen = uniq.map((i) => ({ ...candidates[i], _reason: reasons[i] || '' } as any));
        usedAI = true;
      }
    } catch {
      chosen = candidates.slice(0, 5); // honest fallback: unranked
      if (note && note.trim()) {
        noteInfo = (noteInfo ? noteInfo + ' ' : '') +
          'AI ranking failed this time, so the note was applied only by the simple word rules above - nothing was silently reinterpreted.';
      }
    }
  }

  // When the no-repeat rule is what emptied the pool, say so plainly - a
  // bare "0 qualify" would read like the library has nothing at all.
  let finalNote = chosen.length < 5 && !noteZeroMatch ? `Only ${chosen.length} verified recipes qualify right now - no filler added.` : '';
  if (blockedBySeen > 0) {
    noteInfo = (noteInfo ? noteInfo + ' ' : '') +
      blockedBySeen + ' checked ' + (blockedBySeen === 1 ? 'recipe was' : 'recipes were') +
      ' skipped because you already saw ' + (blockedBySeen === 1 ? 'it' : 'them') + ' in this list.';
  }
  if (chosen.length === 0 && !noteZeroMatch && blockedByHistory > 0) {
    finalNote = 'Every verified recipe under these filters was already suggested in the last 30 days - those ideas come back after that. Try a different filter, or ask for more recipes to be added.';
    noteInfo = noteInfo.replace(/, so the note was ranked by meaning/, ' directly, but nothing new was left to rank');
  }

  // Post-output validation: AI reasons are advisory taste notes and must
  // never contradict the deterministic ingredient match. A reason denying a
  // hard note word ("does not contain corn" on a corn-matched card) is false
  // prose - hide the reason and say so; the card stands on its real match.
  const noteReq = (kwN.words.length > 0
    ? ([...new Set(kwN.pairs.filter((p) => p.interpreted || vocab.indexOf(p.word) !== -1).map((p) => p.word))])
    : []) as string[];
  let hiddenReasons = 0;
  for (const r of chosen as any[]) {
    const reason = String(r._reason || '');
    if (!reason) continue;
    for (const w of noteReq) {
      const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const deny = new RegExp("(does\\s*n['’]?t|does not|do not|not|without)\\s+(actually\\s+)?\\w{0,14}?(contain|have|include|use)\\w*\\b[^.;]*\\b" + esc + "\\b", 'i');
      if (deny.test(reason)) { r._reason = ''; hiddenReasons++; break; }
    }
  }
  if (hiddenReasons > 0) {
    noteInfo = (noteInfo ? noteInfo + ' ' : '') +
      (hiddenReasons === 1 ? 'One AI note was hidden because it contradicted the ingredient match - trust the match, not the note.' :
        hiddenReasons + ' AI notes were hidden because they contradicted the ingredient match - trust the match, not the notes.');
  }

  const ids = chosen.map((r) => videoIdOf(r.video_url));
  return {
    interpreted,
    count: chosen.length,
    usedAI,
    noteInfo,
    note: finalNote,
    picks: chosen.map((r: any) => ({
      name: r.recipe_name, url: r.video_url, time: r.time_notes || '',
      diet: r.diet || '', meal: r.meal_type || '', reason: r._reason || ''
    })),
    ids
  };
}

/** Prose words that appear in ingredient text but are not ingredients:
 * excluded from the typeahead vocabulary (chips must be canonical foods). */
const TYPEAHEAD_STOP = new Set(('about added adds add after again against ahead almost along although always among amount another approximately around aroma avoid ' +
  'before below besides better bring brings broken chef choice claim claims cooked cooking cover cube cubes depending ' +
  'finely fresh freshly grind ground heat heated heaped instead keep keeps large little loosely made make makes medium ' +
  'needed needs note optional other others over piece pieces prefer preference required roughly serve serves serving ' +
  'aside baking base small soak soaked soft soften store stored taste thick thin tightly together total usually very water well whole your').split(' '));

/** Curated single-word ingredient allowlist: a chip is offered only when the
 * word both appears in verified ingredient text AND is a known food word.
 * Deterministic; unknown library words stay reachable as free text. */
const INGREDIENT_ALLOWLIST = new Set((
  'paneer tofu chicken mutton prawn prawns fish salmon egg eggs bacon ham mushroom mushrooms ' +
  'potato potatoes onion onions tomato tomatoes garlic ginger capsicum carrot carrots beans broccoli cauliflower cabbage ' +
  'spinach methi coriander mint curry cucumber cucumbers beetroot radish pumpkin squash zucchini eggplant brinjal okra ' +
  'ladysfinger drumstick peas corn avocado arugula lettuce kale celery leeks pineapple banana bananas apple mango papaya ' +
  'grapes pomegranate orange sweetlime watermelon muskmelon strawberry blueberries dryfruits ' +
  'rice basmati seeraga samba poha aval rava sooji semolina oats quinoa millets ragi bajra jowar wheat atta maida besan ' +
  'cornflour cornstarch riceflour barley sago sabudana vermicelli seviyan noodles pasta spaghetti macaroni bread bun pav ' +
  'tortilla wraps poha puffedrice cornflakes muesli ' +
  'urad chana moong toor masoor rajma chole chickpeas lobia cowpea horsegram sprouts soya soychunks ' +
  'milk curd curds yogurt butter ghee cream buttermilk cheese mozzarella paneer khoya mawa malai condensed evaporated ' +
  'sugar jaggery honey syrup jaggerypowder brown sugar salt rocksalt blacksalt ' +
  'turmeric chilli chillies pepper peppercorns cumin jeera corianderseeds dhaniya mustard fenugreek ajwain hing asafoetida ' +
  'cardamom elaichi cloves cinnamon bayleaf staranise mace javitri nutmeg saffron kewra vanilla rosewater ' +
  'amchur tamarind kokum vinegar pickles ' +
  'groundnut groundnuts peanut peanuts cashew cashews almond almonds walnut walnuts pistachio pista raisins sultanas dates figs ' +
  'sesame gingelly poppyseeds khus coconut copra ' +
  'oil ghee butter vanaspati margarine ' +
  'seeds herbs dill parsley basil oregano rosemary thyme lemongrass springonion scallions ' +
  'ketchup mayonnaise mayo soysauce sriracha tabasco mustard paste puree jams ' +
  'chocolate cocoa coffee tea badam pisin China grass agar agaragar gelatin cornflour custardpowder bakingpowder bakingsoda yeast ' +
  'kesar melonseeds charmagaz lotusseeds makhana phool makhana').split(' ').filter((w) => w.length >= 3));

/** Canonical multi-word ingredient phrases recognised when they appear in the
 * verified library's ingredient text. Used for the typeahead vocabulary so
 * chips can offer "garam masala", not just "garam". Extend deliberately. */
const INGREDIENT_PHRASES = [
  'garam masala', 'chilli powder', 'chili powder', 'red chilli', 'green chilli', 'green chillies',
  'coriander leaves', 'coriander powder', 'mint leaves', 'curry leaves', 'curry powder',
  'cumin powder', 'cumin seeds', 'turmeric powder', 'pepper powder', 'black pepper',
  'chaat masala', 'amchur powder', 'kashmiri red chilli', 'mustard seeds', 'fennel seeds',
  'coconut milk', 'coconut oil', 'sesame oil', 'olive oil', 'vegetable oil', 'sunflower oil',
  'ginger garlic paste', 'garlic cloves', 'spring onion', 'green peas', 'chickpea flour',
  'besan flour', 'rice flour', 'corn flour', 'whole wheat', 'all purpose flour',
  'condensed milk', 'lemon juice', 'tomato ketchup', 'soy sauce',
  'cream cheese', 'processed cheese', 'mozzarella cheese', 'cheese slice',
  'boiled potato', 'sweet corn', 'baby corn', 'bell pepper', 'french beans',
  'jaggery powder', 'cardamom powder', 'saffron strands', 'cashew nuts',
];

/** Canonical ingredient vocabulary for the typeahead: multi-word phrases found
 * in verified ingredient text plus single words from ingredientVocab, with
 * single words dropped when they appear ONLY inside a recognised phrase.
 * Deterministic, no AI, derived only from the verified library. */
export function typeaheadVocab(recipes: RecipeRow[]): string[] {
  const texts = recipes
    .filter((r) => String(r.verified).toLowerCase() === 'yes')
    .map((r) => ' ' + String(r.ingredients || '').toLowerCase() + ' ');
  const joined = texts.join('');
  const count = (term: string) => (joined.match(new RegExp('\\b' + term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g')) || []).length;
  const phrases = new Set<string>();
  for (const p of new Set(INGREDIENT_PHRASES)) {
    if (count(p) > 0) phrases.add(p);
  }
  const singles = new Set(ingredientVocab(recipes).filter((w) => !TYPEAHEAD_STOP.has(w) && INGREDIENT_ALLOWLIST.has(w)));
  for (const ph of phrases) {
    for (const part of ph.split(' ')) {
      if (!singles.has(part)) continue;
      const wordTotal = count(part);
      let inside = 0;
      for (const q of phrases) if (q.indexOf(part) !== -1) inside += count(q);
      if (wordTotal > 0 && inside >= wordTotal) singles.delete(part);
    }
  }
  return [...phrases, ...singles].sort();
}
