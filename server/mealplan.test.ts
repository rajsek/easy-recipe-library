import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateNutrition, slotsFor, generatePlan, compositionFor } from './mealplan.js';

test('slotsFor maps meal types', () => {
  assert.deepEqual(slotsFor('Breakfast'), ['breakfast']);
  assert.deepEqual(slotsFor('Lunch, Dinner'), ['lunch', 'dinner']);
  assert.deepEqual(slotsFor('Snack'), ['snack']);
  assert.deepEqual(slotsFor(''), ['lunch', 'dinner']);
});

test('estimateNutrition returns whole-recipe totals with coverage', () => {
  const e = estimateNutrition('200g paneer, 2 onions, 1 tbsp oil, 100g tomato');
  assert.equal(e.unavailable, false);
  // whole recipe: paneer 200g=610, oil 7.5g=66, tomato 100g=19, onion 220g=106 => ~801
  assert.ok(e.kcal > 750 && e.kcal < 860, `kcal ${e.kcal}`);
  assert.equal(e.coverage_pct, 100);
  assert.equal(e.approx_used, true); // oil
});

test('estimateNutrition unavailable when no quantities', () => {
  const e = estimateNutrition('QUANTITY UNSPECIFIED IN SOURCE - paneer, onion, spices');
  assert.equal(e.unavailable, true);
});

test('generatePlan produces 30 days with slot rules and rotation', () => {
  const mk = (name: string, meal: string) => ({ name, url: 'u', channel: 'c', diet: 'Veg', meal, ingredients: '100g rice', partial: false });
  const recipes = Array.from({ length: 12 }, (_, i) => mk('B' + i, 'Breakfast'))
    .concat(Array.from({ length: 12 }, (_, i) => mk('D' + i, 'Lunch, Dinner')))
    .concat(Array.from({ length: 8 }, (_, i) => mk('S' + i, 'Snack')));
  const videos = [{ id: 'v1', title: 'Some Video', url: 'uv', channel: 'c', category: 'breakfast', status: 'unextracted' }];
  const plan = generatePlan({ recipes, videos, start: '2026-10-27', days: 30, lunchOtherDays: true, servings: 2 });
  assert.equal(plan.days_plan.length, 30);
  assert.equal(plan.days_plan[0].date, '2026-10-27');
  const d0 = plan.days_plan[0];
  assert.deepEqual(d0.slots.map(s => s.slot), ['breakfast', 'lunch', 'snack', 'dinner']);
  // no immediate breakfast repeat
  const bNames = plan.days_plan.map(d => d.slots[0].recipe?.name);
  for (let i = 1; i < bNames.length; i++) assert.notEqual(bNames[i], bNames[i - 1]);
  // video refs labelled alternatives exist for breakfast
  assert.ok(d0.slots[0].video_refs.length >= 1);
});

test('generatePlan excludes lunch Mon/Wed/Fri when lunchOtherDays=false', () => {
  const recipes = [{ name: 'R', url: 'u', channel: 'c', diet: 'Veg', meal: 'Lunch', ingredients: '100g rice', partial: false }];
  const plan = generatePlan({ recipes, videos: [], start: '2026-10-27', days: 7, lunchOtherDays: false, servings: 2 });
  const lunches = plan.days_plan.filter(d => d.slots.some(s => s.slot === 'lunch'));
  assert.deepEqual(lunches.map(l => l.weekday), ['Tuesday', 'Thursday', 'Saturday', 'Sunday']);
});

test('compositionFor flags side dishes vs standalone', () => {
  assert.equal(compositionFor('Vada Curry (Saidapet style, no tomato)', 'Lunch'), 'side_only');
  assert.equal(compositionFor('Ennai Kathirikai (brinjal kuzhambu)', 'Lunch'), 'side_only');
  assert.equal(compositionFor('Tomato Rice (thakkali sadam)', 'Lunch'), 'standalone');
  assert.equal(compositionFor('Besan Bread Toast', 'Breakfast'), 'standalone');
});

test('side_only slots get a concrete staple proposal', () => {
  const recipes = [{ name: 'Vada Curry (Saidapet style, no tomato)', url: 'u', channel: 'c', diet: 'Veg', meal: 'Lunch', ingredients: '100g onion', partial: false }];
  const plan = generatePlan({ recipes, videos: [], start: '2026-10-27', days: 1, lunchOtherDays: true, servings: 2 });
  const lunch = plan.days_plan[0].slots.find(s => s.slot === 'lunch')!;
  assert.equal(lunch.recipe?.composition, 'side_only');
  assert.ok(lunch.recipe?.staple_suggestion?.text.includes('pair with'), JSON.stringify(lunch.recipe?.staple_suggestion));
  assert.ok(!('portion_assumption' in (lunch.recipe as object)), 'no portion assumption field');
});

test('estimateNutrition rejects cards with a missing critical egg count', () => {
  const e = estimateNutrition('Eggs (number not written in the description - shown in the video), 1 onion, 1/4 tsp turmeric');
  assert.equal(e.eligible, false);
  assert.ok(e.ineligible_reasons.some((r) => /egg/i.test(r)), e.ineligible_reasons.join(' | '));
});

test('estimateNutrition rejects cards that exclude deep-frying oil', () => {
  const e = estimateNutrition('250g urad dal, 1 onion, 2 green chillies, oil for deep frying');
  assert.equal(e.eligible, false);
  assert.ok(e.ineligible_reasons.some((r) => /frying/i.test(r)), e.ineligible_reasons.join(' | '));
});

test('estimateNutrition rejects cards with an unstated oil quantity', () => {
  const e = estimateNutrition('200g paneer, 1 onion, oil QUANTITY UNSPECIFIED IN SOURCE');
  assert.equal(e.eligible, false);
  assert.ok(e.ineligible_reasons.some((r) => /oil/i.test(r)), e.ineligible_reasons.join(' | '));
});

test('estimateNutrition rejects proxy stand-ins that are not the same food', () => {
  const e = estimateNutrition('200g paneer, 1 cup curd, 2 tbsp oil');
  assert.equal(e.eligible, false);
  assert.ok(e.ineligible_reasons.some((r) => /stand-in|curd/i.test(r)), e.ineligible_reasons.join(' | '));
});

test('eligible card exposes whole-batch numbers only - no portion division', () => {
  const plan = generatePlan({ recipes: [{ name: 'X', url: 'u', channel: 'c', diet: 'Veg', meal: 'Lunch', ingredients: '200g paneer, 2 onions, 1 tbsp oil, 100g tomato', partial: false }], videos: [], start: '2026-10-27', days: 1, lunchOtherDays: true, servings: 2 });
  const r = plan.days_plan[0].slots.map((s) => s.recipe).find(Boolean)!;
  assert.equal(r.nutrition.eligible, true);
  assert.ok(!('nutrition_per_portion' in r), 'no per-portion block: yield is never stated by a source');
  assert.ok(!('portion_assumption' in r), 'no portion assumption text');
  assert.ok(r.nutrition.kcal > 0);
});

test('estimateNutrition rejects unquantified consumed fat hidden as a method note (tawa oil)', () => {
  // Regression: "oil for the tawa" was classified as a skippable method-note,
  // letting a card publish batch/portion totals with uncounted consumed fat.
  const e = estimateNutrition('1kg rice, 150g urad dal, oil for the tawa');
  assert.equal(e.eligible, false);
  assert.ok(e.ineligible_reasons.some((r) => /oil/i.test(r)), e.ineligible_reasons.join(' | '));
});

test('estimateNutrition rejects critical items used but not in the source ingredient list', () => {
  const e = estimateNutrition('200g paneer, 1 cup milk, cumin powder and sugar that are NOT in the source ingredient list - QUANTITIES UNSPECIFIED IN SOURCE');
  assert.equal(e.eligible, false);
  assert.ok(e.ineligible_reasons.some((r) => /sugar|cumin/i.test(r)), e.ineligible_reasons.join(' | '));
});

test('estimateNutrition rejects cup-quantified dals whose cup weight is borrowed from a different food', () => {
  // urad dal cup weight comes from USDA "Lentils, raw" - a different food's density.
  const e = estimateNutrition('1 cup urad dal, 200g tomato');
  assert.equal(e.eligible, false);
  assert.ok(e.ineligible_reasons.some((r) => /portion weight|stand-in/i.test(r)), e.ineligible_reasons.join(' | '));
  // gram-quantified dal does not touch the borrowed cup weight and stays eligible
  const g = estimateNutrition('150g urad dal, 200g tomato');
  assert.equal(g.eligible, true, g.ineligible_reasons.join(' | '));
});

test('minerals are raw-ingredient sums for matched foods with USDA micro data', () => {
  const e = estimateNutrition('200g paneer, 2 onions, 1 tbsp oil, 100g tomato');
  assert.equal(e.eligible, true, e.ineligible_reasons.join(' | '));
  assert.ok(e.minerals, 'minerals present');
  assert.ok(e.minerals!.ca_mg > 0 && e.minerals!.k_mg > 0 && e.minerals!.zn_mg > 0, JSON.stringify(e.minerals));
  // paneer is calcium-dense (USDA FDC 2705740, 483mg/100g): 200g alone contributes ~966mg
  assert.ok(e.minerals!.ca_mg >= 900, `ca ${e.minerals!.ca_mg}`);
});

test('sodium is shown only when the source quantifies salt', () => {
  const withSalt = estimateNutrition('200g paneer, 100g tomato, 1 tbsp oil, 1 tsp salt');
  assert.equal(withSalt.eligible, true, withSalt.ineligible_reasons.join(' | '));
  // 1 tsp salt = 6g x 388mg/g = 2328mg + ingredient sodium
  assert.ok(withSalt.sodium_mg !== null && withSalt.sodium_mg >= 2328, `sodium ${withSalt.sodium_mg}`);
  const noSalt = estimateNutrition('200g paneer, 100g tomato, 1 tbsp oil');
  assert.equal(noSalt.eligible, true, noSalt.ineligible_reasons.join(' | '));
  assert.equal(noSalt.sodium_mg, null);
  assert.match(noSalt.sodium_note, /withheld/i);
  const vague = estimateNutrition('200g paneer, 100g tomato, 1 tbsp oil, salt to taste');
  assert.equal(vague.sodium_mg, null);
  assert.match(vague.sodium_note, /without a quantity/i);
  const gramSalt = estimateNutrition('200g paneer, 100g tomato, 1 tbsp oil, 6g salt');
  assert.ok(gramSalt.sodium_mg !== null && gramSalt.sodium_mg >= 2328, `sodium ${gramSalt.sodium_mg}`);
});

test('salt does not break the eligibility gate or macros', () => {
  const e = estimateNutrition('200g paneer, 2 onions, 1 tbsp oil, 100g tomato, 1 tsp salt');
  assert.equal(e.eligible, true, e.ineligible_reasons.join(' | '));
  assert.ok(e.kcal > 750 && e.kcal < 860, `kcal ${e.kcal}`); // same as salt-free
  const f = estimateNutrition('200g paneer, 2 onions, 1 tbsp oil, 100g tomato, salt to taste');
  assert.equal(f.eligible, true, f.ineligible_reasons.join(' | '));
});

test('foods without verified micro data are excluded from sums and noted', () => {
  const e = estimateNutrition('100g maida, 200g paneer');
  assert.equal(e.eligible, true, e.ineligible_reasons.join(' | '));
  assert.ok(e.minerals, 'minerals still present from paneer');
  assert.ok(e.micro_gaps.includes('maida_refined_flour'), JSON.stringify(e.micro_gaps));
});

test('jaggery micros come from IFCT 2017 (USDA has no cane-jaggery entry)', () => {
  const e = estimateNutrition('50g jaggery, 200g paneer');
  assert.equal(e.eligible, true, e.ineligible_reasons.join(' | '));
  assert.deepEqual(e.micro_gaps, []);
  assert.ok(e.minerals && e.minerals.ca_mg > 0, JSON.stringify(e.minerals));
});

test('unmatched cards have no minerals and withheld sodium', () => {
  const e = estimateNutrition('QUANTITY UNSPECIFIED IN SOURCE - paneer, onion');
  assert.equal(e.minerals, null);
  assert.equal(e.sodium_mg, null);
});
