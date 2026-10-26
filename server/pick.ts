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
 *  - other plain words -> deterministic score boost (name match beats
 *    ingredient/meal/time match)
 * A note we cannot parse into keywords is ignored and reported as ignored.
 * No semantic claims are made - that needs the opt-in AI ranker.
 */
const NOTE_STOP = new Set(('the a an and or for with without something anything me my we us our please want ' +
  'like love make made dish dishes recipe recipes food some that this these those today tonight kids kid ' +
  'friendly style type eat eating have get give show pick ideas idea').split(' '));

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

export async function pickForMe(
  filter: PickFilter,
  note: string,
  recipes: RecipeRow[],
  excluded: Record<string, true>,
  rankFn?: RankFn
): Promise<PickResult> {
  let candidates = recipes.filter((r) => {
    if (String(r.verified).toLowerCase() !== 'yes') return false;
    const id = videoIdOf(r.video_url);
    if (excluded[id]) return false;
    // 'Non-veg' means anything not strictly Veg (catches 'Egg', 'Contains egg',
    // 'Chicken'...); 'Veg' stays strict - egg dishes are not vegetarian here.
    // 'Veg' is strict; 'Non-veg' means an explicitly confirmed egg/meat
    // dish. Unknown or unclassified diets are excluded by BOTH filters and
    // only ever appear in an unfiltered 'Veg + Non-veg' pick.
    const dc = dietClass(r.diet);
    if (filter && filter.diet === 'Veg' && dc !== 'veg') return false;
    if (filter && filter.diet === 'Non-veg' && dc !== 'nonveg') return false;
    if (filter && filter.diet && filter.diet !== 'Veg' && filter.diet !== 'Non-veg' && r.diet !== filter.diet) return false;
    if (filter && filter.meal && String(r.meal_type || '').toLowerCase().indexOf(filter.meal.toLowerCase()) === -1) return false;
    return true;
  });
  // One idea per video.
  const seen: Record<string, true> = {};
  candidates = candidates.filter((r) => {
    const id = videoIdOf(r.video_url) || r.recipe_name;
    if (seen[id]) return false;
    seen[id] = true; return true;
  });

  let chosen = candidates.slice(0, 5);
  let usedAI = false;
  let noteInfo = '';
  if (note && note.trim() && !rankFn) {
    const { exclusions, keywords } = parseNote(note);
    const parts: string[] = [];
    if (exclusions.length > 0) {
      candidates = candidates.filter((r) => {
        const hay = (r.recipe_name + ' ' + (r.ingredients || '')).toLowerCase();
        return !exclusions.some((x) => hay.indexOf(x) !== -1);
      });
      parts.push('excluded recipes containing ' + exclusions.map((x) => '"' + x + '"').join(', '));
    }
    if (keywords.length > 0 && candidates.length > 0) {
      const scored = candidates.map((r, idx) => {
        const name = r.recipe_name.toLowerCase();
        const body = ((r.meal_type || '') + ' ' + (r.ingredients || '') + ' ' + (r.time_notes || '')).toLowerCase();
        let s = 0;
        for (const k of keywords) {
          if (name.indexOf(k) !== -1) s += 2;
          else if (body.indexOf(k) !== -1) s += 1;
        }
        return { r, idx, s };
      });
      if (scored.some((x) => x.s > 0)) {
        scored.sort((a, b) => b.s - a.s || a.idx - b.idx);
        candidates = scored.map((x) => x.r);
        parts.push('prioritized matches for ' + keywords.map((k) => '"' + k + '"').join(', '));
      }
    }
    noteInfo = parts.length > 0
      ? 'Your note was applied with simple keyword matching (AI ranking is off): ' + parts.join('; ') + '.'
      : 'Your note ("' + note.trim().slice(0, 60) + '") could not be applied - free-text wishes need AI ranking, which is off. Picks below are standard unranked matches.';
    chosen = candidates.slice(0, 5);
  }
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
    }
  }

  const ids = chosen.map((r) => videoIdOf(r.video_url));
  return {
    count: chosen.length,
    usedAI,
    noteInfo,
    note: chosen.length < 5 ? `Only ${chosen.length} verified recipes qualify right now - no filler added.` : '',
    picks: chosen.map((r: any) => ({
      name: r.recipe_name, url: r.video_url, time: r.time_notes || '',
      diet: r.diet || '', meal: r.meal_type || '', reason: r._reason || ''
    })),
    ids
  };
}
