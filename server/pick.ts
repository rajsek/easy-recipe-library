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
export function dietClass(diet?: string): 'veg' | 'nonveg' | 'unknown' {
  const s = String(diet || '').trim().toLowerCase();
  if (s === 'veg' || s === 'vegetarian') return 'veg';
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
  'recipe recipes dish dishes food cook cooking make idea ideas quick easy today tonight tomorrow week weekday weekend').split(' '));

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
  excluded: Record<string, true>,
  classification: Record<string, string>
): { candidates: RecipeRow[]; zeroReason?: string } {
  const parsed = parseNote(question);
  let out = candidates;
  if (parsed.exclusions.length > 0) {
    out = out.filter((r) => {
      const hay = r.recipe_name + ' ' + (r.ingredients || '');
      return !parsed.exclusions.some((x) => wordRe(x).test(hay));
    });
  }
  const q = question.toLowerCase();
  out = out.filter((r) => {
    const id = videoIdOf(r.video_url);
    if (!excluded[id]) return true;
    const short = r.recipe_name.split('(')[0].trim().toLowerCase();
    return short.length >= 4 && q.indexOf(short) !== -1;
  });
  const foodWords = parsed.keywords.filter((k) => classification[k] === 'food' && !ASK_REQUEST_WORDS.has(k));
  if (foodWords.length > 0) {
    const matched = out.filter((r) => {
      const hay = r.recipe_name + ' ' + (r.ingredients || '');
      return foodWords.some((k) => wordRe(k).test(hay));
    });
    if (matched.length === 0) {
      return { candidates: [], zeroReason: 'no verified recipe in the library matches ' + foodWords.map((k) => '"' + k + '"').join(', ') + ' under these filters - nothing invented to fill the gap' };
    }
    out = matched;
  }
  return { candidates: out };
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
  classifyFn?: ClassifyFn
): Promise<PickResult> {
  let blockedByHistory = 0;
  let candidates = filterCandidateRecipes(recipes, filter).filter((r) => {
    const id = videoIdOf(r.video_url);
    if (excluded[id]) { blockedByHistory++; return false; }
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
  const parts: string[] = [];
  if (parsed.exclusions.length > 0) {
    candidates = candidates.filter((r) => {
      const hay = r.recipe_name + ' ' + (r.ingredients || '');
      return !parsed.exclusions.some((x) => wordRe(x).test(hay));
    });
    parts.push('excluded recipes containing ' + parsed.exclusions.map((x) => '"' + x + '"').join(', '));
  }
  if (parsed.keywords.length > 0) {
    // An explicit word in the note is a HARD requirement: a pick that does
    // not mention it is wrong, never "close enough". AI ranking, when on,
    // only re-orders whatever survives this filter.
    const matched = candidates.filter((r) => {
      const hay = r.recipe_name + ' ' + (r.ingredients || '');
      return parsed.keywords.some((k) => wordRe(k).test(hay));
    });
    if (matched.length > 0) {
      candidates = matched;
      parts.push('showing only recipes whose name or ingredients match ' + parsed.keywords.map((k) => '"' + k + '"').join(', '));
    } else if (rankFn) {
      // A word nothing mentions literally may only become a soft
      // ranked-by-meaning wish when the classifier says it is clearly a
      // mood/preference. Foods, dishes, cuisines, allergens - and any word
      // the classifier cannot place or fails on - stay HARD requirements:
      // no match means an honest zero, never an unrelated fallback.
      let allMood = false;
      if (classifyFn) {
        try {
          const cls = await classifyFn(parsed.keywords);
          allMood = parsed.keywords.every((k) => cls[k] === 'mood');
        } catch { allMood = false; }
      }
      if (allMood) {
        parts.push('no recipe name or ingredient mentions ' + parsed.keywords.map((k) => '"' + k + '"').join(', ') + ' directly, so the note was ranked by meaning');
      } else {
        candidates = [];
        noteZeroMatch = true;
        parts.push('no verified recipe matches ' + parsed.keywords.map((k) => '"' + k + '"').join(', ') + ' under these filters - nothing filled in; try fewer filters or a different note');
      }
    } else {
      candidates = [];
      noteZeroMatch = true;
      parts.push('no verified recipe matches ' + parsed.keywords.map((k) => '"' + k + '"').join(', ') + ' under these filters - nothing filled in; try fewer filters or a different note');
    }
  }
  if (note && note.trim() && !rankFn) {
    noteInfo = parts.length > 0
      ? 'Your note was applied with simple keyword matching (AI ranking is off): ' + parts.join('; ') + '.'
      : 'Your note ("' + note.trim().slice(0, 60) + '") could not be applied - free-text wishes need AI ranking, which is off. Picks below are standard unranked matches.';
  } else if (note && note.trim() && parts.length > 0) {
    noteInfo = 'Note constraints applied before ranking: ' + parts.join('; ') + '.';
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
  if (chosen.length === 0 && !noteZeroMatch && blockedByHistory > 0) {
    finalNote = 'Every verified recipe under these filters was already suggested in the last 30 days - those ideas come back after that. Try a different filter, or ask for more recipes to be added.';
    noteInfo = noteInfo.replace(/, so the note was ranked by meaning/, ' directly, but nothing new was left to rank');
  }

  const ids = chosen.map((r) => videoIdOf(r.video_url));
  return {
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
