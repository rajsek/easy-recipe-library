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
  skipped: string[]; // audit trail: fragments excluded and why
  notes: string[];   // conversions/normalizations applied (e.g. 250 ml cup)
  proxies: string[]; // ref entries used that stand in for a different food (limitation)
  eligible: boolean; // safe to show as numbers: no critical ingredient unresolved, no proxy stand-ins
  ineligible_reasons: string[];
}
export interface PlanCard {
  name: string; url: string; channel: string; diet: string; meal: string; partial: boolean;
  nutrition: NutritionEstimate; // whole-recipe totals, not per portion
  nutrition_per_portion: { kcal: number; protein_g: number; fat_g: number; carb_g: number; fibre_g: number } | null; // batch / portions, same assumption
  portion_assumption: string;   // visible assumption, never a proven yield
  composition: 'standalone' | 'side_only';
  staple_suggestion?: { text: string; note: string };
  ingredients: string[];        // source ingredient lines, unmodified
}

/** Concrete staple pairing for side-only dishes. Standard portions, labeled
 *  as proposals - no recipe card and no health target behind them. */
export function stapleFor(name: string): { text: string; note: string } | undefined {
  const n = (name || '').toLowerCase();
  const note = 'Standard portion proposal, not from the recipe card; staple nutrition not yet included.';
  if (/kurma|kuruma/.test(n)) return { text: 'pair with idli x2 (~80 g) or dosa x1 (~90 g)', note };
  if (/chutney|thogayal|thuvaiyal|podi/.test(n)) return { text: 'pair with idli x2 (~80 g) or dosa x1 (~90 g)', note };
  if (/raita|gravy|masala|keema|bhurji/.test(n)) return { text: 'pair with roti x2 (~60 g) or rice 1 cup cooked (~150 g)', note };
  if (/kuzhambu|sambar|rasam|kootu|gotsu|thokku/.test(n)) return { text: 'pair with steamed rice 1 cup cooked (~150 g)', note };
  return { text: 'pair with a staple: rice 1 cup cooked (~150 g), roti x2, or dosa x1', note };
}

/** Dishes that are a side/gravy/dip, not a full meal - the plan must not
 *  present them as a complete slot on their own. */
const SIDE_ONLY = /kuzhambu|kootu(?! sadam)|curry|kurma|chutney|thogayal|thuvaiyal|podi|gravy|raita|pachadi|dip|sambar(?! sadam)|rasam(?! sadam)|thokku|pickle|masala(?! (rice|dosa|idli))/i;
const STAPLE = /rice|sadam|dosa|idli|idly|pongal|upma|roti|chapati|paratha|parotta|bread|toast|pancake|biriyani|biryani|pulao|khichdi|pasta|noodles|vermicelli|semiya|puttu|idiyappam|appam|poha|aval|oats|porridge|sandwich|pizza|bun|pav|roll|wrap/i;
const SNACKY = /salad|soup|kebab|cutlet|vada(?!\s*curry)|bajji|pakoda|pakora|bonda|paniyaram|kheer|payasam|halwa|cake|sweet|poli|obbattu|ladoo|laddu|mysore pak|burfi|barfi|mixture|chivda/i;
export function compositionFor(name: string, meal: string): 'standalone' | 'side_only' {
  const n = (name || '') + ' ' + (meal || '');
  // a side/gravy word makes the dish side_only unless a true staple is present
  if (SIDE_ONLY.test(n)) return STAPLE.test(n) ? 'standalone' : 'side_only';
  if (STAPLE.test(n) || SNACKY.test(n)) return 'standalone';
  return 'standalone';
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
// items with no meaningful energy contribution - excluded from coverage math
const NEGLIGIBLE = /^\s*(salt|water|ice|hing|asafoetida|perungayam|cooking soda|baking soda|appam soda)\b/i;
const REF_KEYS: [RegExp, string][] = [
  [/\bghee\b|\boil\b|vanaspati|ennai/i, 'oil_generic'],
  [/soya chunks?|meal ?maker|soya nuggets?|soya granules/i, 'soya_chunks'],
  [/fennel|saunf|sombu|perunjeeragam/i, 'fennel_seed'],
  [/roasted gram|pottukadalai|pottu kadalai/i, 'bengal_gram_dal'],
  [/urad dal|black gram|ulundhu|ullundhu/i, 'urad_dal_black_gram'],
  [/toor dal|tur dal|tuvar|arhar|thuvaram|pigeon pea|tuvaram/i, 'toor_dal_red_gram'],
  [/bell pepper/i, 'capsicum'],
  [/black pepper|pepper(?! p)/i, 'black_pepper'],
  [/mustard/i, 'mustard_seeds'],
  [/coriander (seeds?|powder)|dhania/i, 'coriander_seeds'],
  [/fenugreek seeds|methi seeds|vendhayam/i, 'fenugreek_seeds'],
  [/cloves?/i, 'cloves'],
  [/cardamom|elaichi|elakkai/i, 'cardamom_green'],
  [/green chill/i, 'green_chillies'],
  [/(dry |dried |red |kashmiri )?chilli(es)?( powder)?|milagai/i, 'red_chilli_dry'],
  [/mushroom/i, 'button_mushroom'],
  [/sooji|rava|semolina/i, 'sooji_semolina'],
  [/maida|refined flour|all[- ]purpose/i, 'maida_refined_flour'],
  [/atta|wheat flour|\bflour\b/i, 'atta_whole_wheat_flour'],
  [/(\d+\s*)?eggs?/i, 'egg_chicken_whole_raw'],
  [/\bbutter\b/i, 'butter'],
  [/\bsugar\b/i, 'sugar_white'],
  [/paneer/i, 'paneer'], [/poha|rice flakes|flattened rice|aval/i, 'poha_rice_flakes'],
  [/bengal gram|chana dal|channa dal|kadala paruppu/i, 'bengal_gram_dal'],
  [/besan|gram flour|kadalai maavu/i, 'bengal_gram_dal'],
  [/moong dal|green gram|payatham paruppu|paasi paruppu/i, 'green_gram_dal'],
  [/green peas|\bmatar\b|\bpattani\b/i, 'green_peas'],
  [/tomato/i, 'tomato'], [/onion|shallot|vengayam/i, 'onion_big'], [/potato/i, 'potato'],
  [/capsicum|bell pepper/i, 'capsicum'], [/carrot/i, 'carrot'], [/french beans|\bbeans\b/i, 'french_beans'],
  [/cauliflower/i, 'cauliflower'], [/coriander leaves|cilantro|kothamalli/i, 'coriander_leaves'],
  [/curry leaves|karuveppilai/i, 'curry_leaves'], [/ginger/i, 'ginger'], [/garlic/i, 'garlic'],
  [/turmeric/i, 'turmeric_powder'], [/cumin|jeera|jeeragam/i, 'cumin_seed'],
  [/tamarind|puli/i, 'tamarind_pulp'], [/jaggery|vellam/i, 'jaggery_cane'],
  [/coconut/i, 'coconut_fresh'], [/jowar|sorghum|cholam/i, 'jowar'], [/raisins?|dry grapes/i, 'raisins_black'], [/peanuts?|ground ?nut|verkadalai|nilakadalai/i, 'peanut_groundnut'], [/brinjal|kathirikai|eggplant|aubergine/i, 'brinjal_avg'], [/banana(?! leaf)/i, 'banana_ripe_poovam'], [/mint|pudina/i, 'mint_leaves'], [/sesame|gingelly seeds|\bellu\b/i, 'sesame_gingelly_black'], [/soy sauce|soya sauce/i, 'soy_sauce'], [/ketchup|catsup/i, 'ketchup'],
  [/milk(?!maid)/i, 'milk_cow'],
  [/cheddar|cheese/i, 'cheddar'], [/sour cream/i, 'sour_cream'], [/\bcream\b/i, 'cream_heavy'],
  [/\bcabbage\b/i, 'cabbage'], [/\bchicken\b/i, 'chicken_breast'],
  [/tuna/i, 'tuna_canned'], [/bacon/i, 'bacon_cooked'], [/sausage/i, 'sausage_pork'],
  [/corn ?flour|cornstarch|corn starch/i, 'corn_flour'],
  [/mayonnaise|\bmayo\b/i, 'mayonnaise'],
  [/cornflakes|corn flakes/i, 'corn_flakes'], [/sweet corn|corn kernels|\bcorn\b/i, 'sweet_corn'],
  [/\bbread\b/i, 'bread_white'], [/cashew|kaju|munthiri/i, 'cashew'], [/almonds?|badam/i, 'almond'], [/khoa|khoya|mawa/i, 'khoa'],
  [/curd|yogurt|dahi|thayir/i, 'curd'],
  [/\brice\b|basmati|raw rice|boiled rice/i, 'rice_raw'],
];
const UNIT_G: [RegExp, number][] = [
  [/\bkgs?\b/, 1000], [/\bgrams?\b|\bgms?\b|\bg\b/, 1], [/\bml\b/, 1], [/\blitres?\b|\bliters?\b|\bltr\b|\bl\b/, 1000],
  [/tablespoons?|tbsp/, 7.5], [/teaspoons?|tsp/, 2.5], [/pinch/, 0.4], [/sprigs?/, 2], [/handful/, 25],
];
// ingredients whose omission materially changes a calorie claim
const CRITICAL = /eggs?|paneer|chicken|mutton|fish|prawn|rice|basmati|dal\b|paruppu|flour|maida|atta|besan|rava|sooji|semolina|poha|aval|oil|ghee|butter|cream|milk|curd|yogurt|cheese|potato|soya|mushroom|bread|pasta|spaghetti|noodles?|sugar|jaggery|coconut|peanut|groundnut|cashew|almond|mayonnaise|sago|javvarisi|oats|cornflakes/i;

const COUNT_G: [RegExp, number][] = [
  [/onion/i, 110], [/tomato/i, 90], [/eggs?/i, 50], [/capsicum/i, 120], [/potato/i, 150],
  [/green chill/i, 5], [/garlic/i, 5], [/ginger/i, 10], [/small piece coconut|piece of coconut|coconut piece/i, 25], [/bananas?(?! leaf)/i, 100], [/scoop/i, 30], [/cashew/i, 1.6], [/almond/i, 1.2], [/lemon/i, 45], [/banana leaf/i, 20], [/\bcabbage\b/i, 500], [/\bcarrot\b/i, 61], [/chicken (fillet|breast)/i, 120], [/mushroom/i, 18], [/\bbread\b/i, 29],
];
const NUM = /(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?(?:\s*-\s*\d+(?:\.\d+)?)?)/;

function refKeyFor(text: string): string | null {
  for (const [re, key] of REF_KEYS) if (re.test(text)) return key;
  return null;
}

/** Estimate one recipe card's WHOLE-RECIPE nutrition from stated ingredient
 *  quantities. Grams math only; no invented precision, no invented yield. */
export function estimateNutrition(ingredients: string, _servings?: number): NutritionEstimate {
  const zero: NutritionEstimate = { kcal: 0, protein_g: 0, fat_g: 0, carb_g: 0, fibre_g: 0, coverage_pct: 0, approx_used: false, unavailable: true, skipped: [], notes: [], proxies: [], eligible: false, ineligible_reasons: ['no estimate possible - quantities unspecified in source'] };
  if (!ingredients || /QUANTITY UNSPECIFIED/i.test(ingredients) && !/\d/.test(ingredients)) return zero;
  let kcal = 0, p = 0, f = 0, c = 0, fib = 0, matchedG = 0, parsedG = 0, approx = false;
  const skipped: string[] = [];
  const notes: string[] = [];
  const proxies = new Set<string>();
  const metricCup = /250\s*ml\s*cup/i.test(ingredients); // source declares a 250 ml metric cup
  const REVERSE = /^(.+?)\s*[-\u2013]\s*((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)\s*(k?g|ml|l|litre?s?|cups?|tsp|tbsp|tablespoons?|teaspoons?)\.?\s*$/i;
  for (const frag0 of ingredients.split(/[,\n;]| \+ |\.\s+| and (?=\d|~|a\s+(?:cup|tsp|tbsp|handful|pinch|few|little))/i)) {
    // normalise source quantity styles to "<qty> <unit> <name>"; skip deep-frying/roasting oil (absorbed amount unknown, not eaten whole)
    const parenG = frag0.match(/\(~?\s*(\d+(?:\.\d+)?)\s*g\s*\)/); // source's own gram conversion, e.g. "(~220g)"
    const parenU = frag0.match(/\(~?\s*(\d+(?:\.\d+)?)\s*(tbsp|tsp|cups?)\s*\)/i); // source's own volume conversion, e.g. "(4 tbsp)"
    let frag = frag0.replace(/\s*\([^)]*\)\s*$/, '').trim();
    frag = frag.replace(/\b(small|medium|large|big|heaped|level|generous)\s+(?=(cups?|tsp|tbsp)\b)/i, '');
    if (parenU && !parenG) frag = `${parenU[1]} ${parenU[2]} ${frag.replace(/\([^)]*\)/, '')}`;
    const dz = frag.match(/^(\d+(?:\.\d+)?)\s*dozen\s+(.*)$/i);
    if (dz) frag = `${parseFloat(dz[1]) * 12} ${dz[2]}`;
    if (!NUM.test(frag)) {
      const rv = frag.match(REVERSE);
      if (rv) frag = `${rv[2]} ${rv[3]} ${rv[1]}`;
      else {
        const nf = frag.match(/^(.+?)\s+((?:\d+\s+)?\d+\/\d+|\d+(?:\.\d+)?)\s*(k?g|ml|l|litre?s?|liters?|cups?|tsp|tbsp|tablespoons?|teaspoons?)\.?\s*(.*)$/i);
        if (nf) frag = `${nf[2]} ${nf[3]} ${nf[1]} ${nf[4]}`;
        else {
          const nc = frag.match(/^([^0-9]+?)\s+(\d+)\s*(?:\(|$)/) || frag.match(/^([^0-9]+?)\s+(\d+)\s+(?:whole\s+\w+|medium|small|large|big)\b/);
          if (nc && !/\d/.test(nc[1])) frag = `${nc[2]} ${nc[1]}`;
        }
      }
    }
    if (/\b(for|to)\s+(deep[- ]?fry|frying)|deep[- ]?fry/i.test(frag) && /\b(oil|ghee)\b/i.test(frag)) { skipped.push('frying-oil: ' + frag0.trim()); continue; }
    // Unquantified CONSUMED fat (tawa oil, greasing ghee) is calorie-critical:
    // never let the method-note pattern absorb it - classify as no-qty instead.
    const fatWord = /\b(oil|ghee|butter|cream|fat)\b/i.test(frag);
    // Ingredients named as used-but-not-listed in the source: a critical one
    // (sugar etc.) with unknown quantity is a completeness gap, not a note.
    const unlisted = /NOT in the source ingredient/i.test(frag);
    if (/^(washed|soaked?|soak|drained?|grind|grated|chopped|sliced|to a\b|as needed)/i.test(frag) || /enough for|pan size|for the tawa|pressure[- ]cooked|whistles?|NOT in the source ingredient|\breserved\b/i.test(frag)) {
      if (fatWord || (unlisted && CRITICAL.test(frag))) { skipped.push('no-qty: ' + frag0.trim()); continue; }
      skipped.push('method-note: ' + frag0.trim()); continue;
    }
    if (/TO-CONFIRM/i.test(frag)) continue;
    const stripped = frag.replace(new RegExp('^\\s*' + NUM.source + '\\s*(kg|g|gm|gms|ml|l|ltr|tsp|tbsp|tablespoons?|teaspoons?|cups?|pinch|sprigs?|handful)?\\s*', 'i'), '');
    if (NEGLIGIBLE.test(stripped) || /\bwater\b/i.test(stripped) && !refKeyFor(stripped)) continue;
    const m = frag.match(NUM);
    if (!m) { if (!NEGLIGIBLE.test(frag) && !/\bwater\b/i.test(frag)) skipped.push('no-qty: ' + frag0.trim()); continue; }
    const qtxt = m[1].trim();
    let qty: number;
    if (/^\d+\s+\d+\/\d+$/.test(qtxt)) { const [w, fr] = qtxt.split(/\s+/); const [a, b] = fr.split('/'); qty = parseInt(w) + parseInt(a) / parseInt(b); }
    else if (/^\d+\/\d+$/.test(qtxt)) { const [a, b] = qtxt.split('/'); qty = parseInt(a) / parseInt(b); }
    else qty = parseFloat(qtxt.split('-')[0]);
    const rest = frag.slice(m.index! + m[1].length);
    let grams = 0;
    const um = rest.match(/^\s*([a-zA-Z]+)/);
    const unitWord = um ? um[1].toLowerCase() : '';
    const key = refKeyFor(frag);
    let unitMul = 0;
    for (const [re, mul] of UNIT_G) { if (re.test(unitWord) || re.test(rest.slice(0, 12))) { unitMul = mul; break; } }
    let unitKind: 'cup' | 'tsp' | 'tbsp' | null = null;
    if (/^cups?$/i.test(unitWord) || /^\s*cups?\b/i.test(rest)) unitKind = 'cup';
    else if (/^tsp$/i.test(unitWord) || /teaspoons?/i.test(unitWord)) unitKind = 'tsp';
    else if (/^tbsp$/i.test(unitWord) || /tablespoons?/i.test(unitWord)) unitKind = 'tbsp';
    if (unitKind && key && REF[key]) {
      const e: any = REF[key];
      let w = unitKind === 'cup' ? e.cup_g : unitKind === 'tsp' ? e.tsp_g : e.tbsp_g;
      if (w && unitKind === 'cup' && metricCup) { w = w * 250 / 240; if (!notes.length) notes.push('source declares 250 ml cup; USDA cup weights (240 ml) scaled x1.042'); }
      if (w) {
        unitMul = w; // ingredient-specific, sourced portion weight
        if ((e as any).portion_proxy) proxies.add(key + ' (portion weight from a different food)'); // density borrowed from another food - not exact
      } else unitMul = 0;   // no sourced density for this ingredient: leave unconverted
    }
    if (parenG) grams = parseFloat(parenG[1]);
    else if (unitMul) grams = qty * unitMul;
    else {
      for (const [re, each] of COUNT_G) { if (re.test(frag)) { grams = qty * each; break; } }
      if (!grams) { skipped.push('no-density: ' + frag0.trim()); continue; }
    }
    if (grams <= 0) continue;
    parsedG += grams;
    if (!key || !REF[key]) { skipped.push('no-ref: ' + frag0.trim()); continue; }
    const e = REF[key];
    if (e.approx) approx = true;
    if ((e as any).proxy) proxies.add(key);
    const s = grams / 100;
    kcal += e.kcal * s; p += e.protein_g * s; f += e.fat_g * s; c += e.carb_g * s; fib += e.fibre_g * s;
    matchedG += grams;
  }
  if (matchedG === 0) return zero;
  // Eligibility gate (semantic completeness, not weight coverage): numbers are
  // shown only when every semantically critical ingredient resolved AND no
  // proxy stand-ins were used (proxies are not nutritionally equivalent foods).
  const ineligible: string[] = [];
  for (const s of skipped) {
    const [reason, ...fragParts] = s.split(': ');
    const frag = fragParts.join(': ');
    if (reason === 'frying-oil') ineligible.push(`excludes deep-frying oil - absorbed amount unknown (${frag.slice(0, 60)})`);
    else if (/^[\w-]+\)?$/.test(frag.trim()) && (frag.trim().endsWith(')') || frag.includes('-'))) { /* split leftover token, e.g. "cornflakes-like)" */ }
    else if (reason === 'method-note' || /optional|also fine/i.test(frag)) { /* recipe's own note/option */ }
    else if ((reason === 'no-qty' || reason === 'no-ref' || reason === 'no-density') && CRITICAL.test(frag))
      ineligible.push(`source is missing a critical quantity (${reason.replace('no-', 'no ')}): ${frag.slice(0, 80)}`);
  }
  for (const px of proxies) ineligible.push(`estimated stand-in used for ${px.replace(/_/g, ' ')} - not the same food, so exact numbers are withheld`);
  return {
    eligible: ineligible.length === 0, ineligible_reasons: ineligible,
    kcal: Math.round(kcal), protein_g: Math.round(p * 10) / 10, fat_g: Math.round(f * 10) / 10,
    carb_g: Math.round(c * 10) / 10, fibre_g: Math.round(fib * 10) / 10,
    coverage_pct: parsedG ? Math.round(matchedG / parsedG * 100) : 100, approx_used: approx, unavailable: false,
    skipped, notes, proxies: [...proxies],
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
    // Original request: Mon/Wed/Fri are 3-slot days (no lunch); all other
    // days include lunch. Editable default pending user confirmation.
    const noLunch = wd === 1 || wd === 3 || wd === 5;
    const active: SlotId[] = ['breakfast'];
    if (lunchOtherDays || !noLunch) active.push('lunch');
    active.push('snack', 'dinner');
    const dateStr = d.toISOString().slice(0, 10);
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][wd];
    const slots: PlanSlot[] = active.map((s) => {
      const pool = pools[s];
      let recipe: PlanCard | null = null;
      if (pool.length) {
        const r = pool[used[s] % pool.length];
        used[s] += 1;
        const comp = compositionFor(r.name, r.meal);
        const nut = estimateNutrition(r.ingredients);
        const per = nut.eligible
          ? { kcal: Math.round(nut.kcal / servings), protein_g: Math.round(nut.protein_g / servings * 10) / 10,
              fat_g: Math.round(nut.fat_g / servings * 10) / 10, carb_g: Math.round(nut.carb_g / servings * 10) / 10,
              fibre_g: Math.round(nut.fibre_g / servings * 10) / 10 }
          : null;
        recipe = { name: r.name, url: r.url, channel: r.channel, diet: r.diet, meal: r.meal, partial: !!r.partial,
          nutrition: nut,
          nutrition_per_portion: per,
          portion_assumption: `whole recipe treated as ${servings} portion(s) - assumption, not a stated yield`,
          composition: comp,
          staple_suggestion: comp === 'side_only' ? stapleFor(r.name) : undefined,
          ingredients: String(r.ingredients || '').split(/\n+/).map((x) => x.trim()).filter(Boolean) };
      }
      const vrefs = vidPool[s].slice((used[s] * 2) % Math.max(1, vidPool[s].length), (used[s] * 2) % Math.max(1, vidPool[s].length) + 2);
      return { slot: s, recipe, video_refs: vrefs };
    });
    out.push({ date: dateStr, weekday, slots });
  }
  return {
    start: input.start, days, servings, lunch_other_days: lunchOtherDays, days_plan: out,
    assumptions: [
      'SAMPLE MENU ONLY - not personalized: dietary needs, allergies and who is eating are not confirmed yet.',
      `Nutrition, where shown, lists the WHOLE RECIPE BATCH first and the per-portion split second; the batch number is not one meal. 'Portions' (currently ${servings}) is a visible division assumption, not a yield stated by any recipe or a health target. Cards whose source leaves a critical quantity unstated (like oil or eggs) show no numbers at all.`,
      'Numbers appear only on cards that passed a full ingredient/unit audit: every critical quantity (staples, protein, oil, dairy, eggs) must be stated in the source and resolvable with ingredient-specific weights. Cards missing any of these say so instead of showing a partial sum.',
      'Video references below a slot are unextracted videos - reference pointers only, not recipe or nutrition claims.',
      'Lunch pattern: ' + (lunchOtherDays ? 'lunch every day (editable)' : 'no lunch on Monday, Wednesday, Friday; lunch on all other days (from the original request, editable)') + '.',
    ],
    source_note: 'Nutrition sources: ICMR-NIN Indian Food Composition Tables 2017 and USDA SR Legacy (public bulk data), per-100g values, energy kJ->kcal (/4.184); cup/tsp/tbsp converted with ingredient-specific portion weights from the same sources. Numbers appear only on cards whose critical quantities are fully stated in the source; stand-in ingredients that are not the same food (e.g. milk for curd) are not used for published numbers. Micronutrients are not shown yet - source fields and cooking-retention limits are still being verified.',
  };
}
