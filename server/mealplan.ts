/**
 * 30-day meal-plan generator. Builds a day-by-day plan from the extracted
 * recipe cards (DB-driven, on-demand - never a build-time artifact), and
 * estimates nutrition per serving from IFCT 2017 per-100g reference values
 * (server/nutrition-ref.json). Honesty rules: quantities read
 * "QUANTITY UNSPECIFIED IN SOURCE" stay unestimated; unmapped ingredients
 * lower the visible coverage %; approximated reference entries (oils, curd)
 * are flagged; alternatives from unextracted videos are video references
 * only, never cooking or nutrition claims.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface RefEntry { kcal: number; protein_g: number; fat_g: number; carb_g: number; fibre_g: number; approx?: boolean; note?: string; }
export interface NutritionEstimate {
  kcal: number; protein_g: number; fat_g: number; carb_g: number; fibre_g: number;
  coverage_pct: number; approx_used: boolean; unavailable: boolean;
}
export interface PlanCard {
  name: string; url: string; channel: string; diet: string; meal: string; partial: boolean;
  nutrition: NutritionEstimate;
}
export interface VideoRef { title: string; url: string; channel: string; }
export interface PlanSlot { slot: string; recipe: PlanCard | null; video_refs: VideoRef[]; }
export interface PlanDay { date: string; weekday: string; slots: PlanSlot[]; }
export interface PlanResult {
  start: string; days: number; servings: number; lunch_other_days: boolean;
  days_plan: PlanDay[];
  assumptions: string[];
  source_note: string;
}

const REF: Record<string, RefEntry> = (() => {
  try { return JSON.parse(readFileSync(new URL('./nutrition-ref.json', import.meta.url), 'utf8')); }
  catch { return {}; }
})();

// ingredient keyword -> ref key (order matters: specific before generic)
const REF_KEYS: [RegExp, string][] = [
  [/paneer/i, 'paneer'], [/poha|rice flakes|flattened rice|aval/i, 'poha_rice_flakes'],
  [/bengal gram|chana dal|channa dal|kadala paruppu/i, 'bengal_gram_dal'],
  [/besan|gram flour|kadalai maavu/i, 'bengal_gram_dal'],
  [/moong dal|green gram|payatham paruppu|paasi paruppu/i, 'green_gram_dal'],
  [/tomato/i, 'tomato'], [/onion|shallot|vengayam/i, 'onion_big'], [/potato/i, 'potato'],
  [/capsicum|bell pepper/i, 'capsicum'], [/carrot/i, 'carrot'], [/french beans|\bbeans\b/i, 'french_beans'],
  [/cauliflower/i, 'cauliflower'], [/coriander leaves|cilantro|kothamalli/i, 'coriander_leaves'],
  [/curry leaves|karuveppilai/i, 'curry_leaves'], [/ginger/i, 'ginger'], [/garlic/i, 'garlic'],
  [/turmeric/i, 'turmeric_powder'], [/cumin|jeera|jeeragam/i, 'cumin_seed'],
  [/tamarind|puli/i, 'tamarind_pulp'], [/jaggery|vellam/i, 'jaggery_cane'],
  [/coconut/i, 'coconut_fresh'], [/khoa|khoya|mawa/i, 'khoa'],
  [/curd|yogurt|dahi|thayir/i, 'curd'], [/milk(?!maid)/i, 'milk_cow'],
  [/ghee|oil|vanaspati/i, 'oil_generic'],
  [/\brice\b|basmati|raw rice|boiled rice/i, 'rice_raw'],
];
const UNIT_G: [RegExp, number][] = [
  [/\bkgs?\b/, 1000], [/\bgrams?\b|\bgms?\b|\bg\b/, 1], [/\bml\b/, 1], [/\blitres?\b|\bliters?\b|\bltr\b|\bl\b/, 1000],
  [/tablespoons?|tbsp/, 7.5], [/teaspoons?|tsp/, 2.5], [/cups?/, 120], [/pinch/, 0.4], [/sprigs?/, 2], [/handful/, 25],
];
const COUNT_G: [RegExp, number][] = [
  [/onion/, 110], [/tomato/, 90], [/eggs?/, 50], [/capsicum/, 120], [/potato/, 150],
  [/green chill/, 5], [/garlic/, 5], [/cashew/, 1.6], [/almond/, 1.2], [/lemon/, 45], [/banana leaf/, 20],
];
const NUM = /(\d+(?:\.\d+)?(?:\s*[-/]\s*\d+(?:\.\d+)?)?)/;

function refKeyFor(text: string): string | null {
  for (const [re, key] of REF_KEYS) if (re.test(text)) return key;
  return null;
}

/** Estimate one recipe card's nutrition per serving. Grams math only; no invented precision. */
export function estimateNutrition(ingredients: string, servings: number): NutritionEstimate {
  const zero: NutritionEstimate = { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0, fibre_g: 0, coverage_pct: 0, approx_used: false, unavailable: true };
  if (!ingredients || /QUANTITY UNSPECIFIED/i.test(ingredients) && !/\d/.test(ingredients)) return zero;
  let kcal = 0, p = 0, f = 0, c = 0, fib = 0, matchedG = 0, parsedG = 0, approx = false;
  for (const frag of ingredients.split(/[,\n;]| and /i)) {
    const m = frag.match(NUM);
    if (!m) continue; // quantity not stated in source -> excluded from estimate
    let qty = parseFloat(m[1].split(/[-/]/)[0]);
    const rest = frag.slice(m.index! + m[1].length);
    let grams = 0;
    const um = rest.match(/^\s*([a-zA-Z]+)/);
    const unitWord = um ? um[1].toLowerCase() : '';
    let unitMul = 0;
    for (const [re, mul] of UNIT_G) { if (re.test(unitWord) || re.test(rest.slice(0, 12))) { unitMul = mul; break; } }
    if (unitMul) grams = qty * unitMul;
    else {
      for (const [re, each] of COUNT_G) { if (re.test(frag)) { grams = qty * each; break; } }
      if (!grams) continue; // count item we don't have a size for -> unparsed
    }
    if (grams <= 0) continue;
    parsedG += grams;
    const key = refKeyFor(frag);
    if (!key || !REF[key]) continue;
    const e = REF[key];
    if (e.approx) approx = true;
    const s = grams / 100;
    kcal += e.kcal * s; p += e.protein_g * s; f += e.fat_g * s; c += e.carb_g * s; fib += e.fibre_g * s;
    matchedG += grams;
  }
  if (matchedG === 0) return zero;
  const div = Math.max(1, servings);
  return {
    kcal: Math.round(kcal / div), protein_g: Math.round(p / div * 10) / 10, fat_g: Math.round(f / div * 10) / 10,
    carb_g: Math.round(c / div * 10) / 10, fibre_g: Math.round(fib / div * 10) / 10,
    coverage_pct: parsedG ? Math.round(matchedG / parsedG * 100) : 100, approx_used: approx, unavailable: false,
  };
}

export type SlotId = 'breakfast' | 'lunch' | 'snack' | 'dinner';
const SLOT_ORDER: SlotId[] = ['breakfast', 'lunch', 'snack', 'dinner'];

/** Map a card's meal_type string to the slots it can fill. */
export function slotsFor(meal: string): SlotId[] {
  const m = (meal || '').toLowerCase();
  const out: SlotId[] = [];
  if (/breakfast|tiffin|idli|dosa/.test(m)) out.push('breakfast');
  if (/lunch/.test(m)) out.push('lunch');
  if (/dinner|main course|curry|gravies|side dish for (roti|rice)|rice variety/.test(m)) out.push('dinner');
  if (/snack|starter|tea|chaat|evening/.test(m)) out.push('snack');
  if (!out.length && /sweet|dessert|kheer|payasam/.test(m)) out.push('snack'); // sweets as occasional snack slot
  return out.length ? out : ['lunch', 'dinner'];
}

function isMeat(diet: string): boolean {
  const d = (diet || '').toLowerCase();
  return d.includes('non-veg') && !/veg/.test(d.replace('non-veg', '')) ? true : /non-veg/.test(d);
}

export interface PlanInput {
  recipes: { name: string; url: string; channel: string; diet: string; meal: string; ingredients: string; partial: boolean }[];
  videos: { id: string; title: string; url: string; channel: string; category: string; status: string }[];
  start: string; days?: number; lunchOtherDays?: boolean; servings?: number;
}

const VIDEO_CAT: Record<SlotId, RegExp> = {
  breakfast: /breakfast/i, lunch: /lunch|dinner/i, snack: /snack/i, dinner: /lunch|dinner/i,
};

export function generatePlan(input: PlanInput): PlanResult {
  const days = Math.min(Math.max(1, input.days ?? 30), 45);
  const servings = Math.min(Math.max(1, input.servings ?? 2), 10);
  const lunchOtherDays = input.lunchOtherDays ?? true;
  const pools: Record<SlotId, typeof input.recipes> = { breakfast: [], lunch: [], snack: [], dinner: [] };
  for (const r of input.recipes) {
    if (isMeat(r.diet)) continue; // default plan excludes meat; egg stays
    for (const s of slotsFor(r.meal)) pools[s].push(r);
  }
  const startDate = new Date(input.start + 'T00:00:00Z');
  const used: Record<SlotId, number> = { breakfast: 0, lunch: 0, snack: 0, dinner: 0 };
  const vidPool: Record<SlotId, VideoRef[]> = { breakfast: [], lunch: [], snack: [], dinner: [] };
  for (const v of input.videos) {
    if (String(v.status).toLowerCase() === 'parsed-to-recipe') continue;
    for (const s of SLOT_ORDER) if (VIDEO_CAT[s].test(v.category || '') && vidPool[s].length < 12)
      vidPool[s].push({ title: v.title, url: v.url, channel: v.channel });
  }
  const out: PlanDay[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(startDate.getTime() + i * 86400000);
    const wd = d.getUTCDay(); // 0 Sun ... 6 Sat
    const active: SlotId[] = ['breakfast'];
    if (lunchOtherDays || wd === 3 || wd === 6) active.push('lunch');
    active.push('snack', 'dinner');
    const dateStr = d.toISOString().slice(0, 10);
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd];
    const slots: PlanSlot[] = active.map((s) => {
      const pool = pools[s];
      let recipe: PlanCard | null = null;
      if (pool.length) {
        const r = pool[used[s] % pool.length];
        used[s] += 1;
        recipe = { name: r.name, url: r.url, channel: r.channel, diet: r.diet, meal: r.meal, partial: !!r.partial, nutrition: estimateNutrition(r.ingredients, servings) };
      }
      const vrefs = vidPool[s].slice((used[s] * 2) % Math.max(1, vidPool[s].length), (used[s] * 2) % Math.max(1, vidPool[s].length) + 2);
      return { slot: s, recipe, video_refs: vrefs };
    });
    out.push({ date: dateStr, weekday, slots });
  }
  return {
    start: input.start, days, servings, lunch_other_days: lunchOtherDays, days_plan: out,
    assumptions: [
      `Nutrition is a per-serving estimate for ${servings} servings, from IFCT 2017 per-100g reference values (ICMR-NIN), matched by ingredient keyword.`,
      'Coverage % = share of stated ingredient weight that matched a reference entry; unmapped ingredients (e.g. some dals, spice pastes) are excluded.',
      'Cards whose source stated no quantities have no estimate.',
      'Approximate reference entries are used for cooking oil/ghee and curd (flagged).',
      'Video references below a slot are unextracted videos - reference pointers only, not recipe or nutrition claims.',
      'Lunch is planned ' + (lunchOtherDays ? 'every day' : 'on Wednesday and Saturday only') + '.',
    ],
    source_note: 'ICMR-NIN Indian Food Composition Tables 2017 (nin.res.in/ebooks/IFCT2017.pdf); energy converted kJ->kcal (/4.184).',
  };
}
