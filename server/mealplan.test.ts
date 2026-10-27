import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateNutrition, slotsFor, generatePlan, compositionFor } from './mealplan.js';

test('slotsFor maps meal types', () => {
  assert.deepEqual(slotsFor('Breakfast'), ['breakfast']);
  assert.deepEqual(slotsFor('Lunch, Dinner'), ['lunch', 'dinner']);
  assert.deepEqual(slotsFor('Snack'), ['snack']);
  assert.deepEqual(slotsFor(''), ['lunch', 'dinner']);
});

test('estimateNutrition sums per serving with coverage', () => {
  const e = estimateNutrition('200g paneer, 2 onions, 1 tbsp oil, 100g tomato', 2);
  assert.equal(e.unavailable, false);
  // paneer 200g = 305*2, oil 7.5g=66, tomato 100g=19, onion 220g=106 => ~801/2
  assert.ok(e.kcal > 350 && e.kcal < 450, `kcal ${e.kcal}`);
  assert.equal(e.coverage_pct, 100);
  assert.equal(e.approx_used, true); // oil
});

test('estimateNutrition unavailable when no quantities', () => {
  const e = estimateNutrition('QUANTITY UNSPECIFIED IN SOURCE - paneer, onion, spices', 2);
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
