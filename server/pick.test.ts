import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickForMe, excludedIds, videoIdOf } from './pick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demo = JSON.parse(readFileSync(path.join(__dirname, 'demo-data.json'), 'utf8'));

function rowsFromGrid(values: any[][]): any[] {
  const hdr = values[0].map(String);
  return values.slice(1).map((r) => Object.fromEntries(hdr.map((h, j) => [h, r[j] ?? ''])));
}
const RECIPES = rowsFromGrid(demo.recipes);
const HISTORY = demo.history;
const PICKS = demo.picks;
const NOW = new Date('2026-10-26T12:00:00');

test('30-day exclusion: recent suggested+cooked excluded, old suggestion not, saved-for-later not', () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  assert.ok(ex['4CrJpfLkT3o'], 'recent suggested excluded');
  assert.ok(ex['3qb0x14XRTA'], 'recent cooked excluded');
  assert.ok(!ex['oOHH3oB7OOk'], '>30d suggestion NOT excluded');
  assert.ok(!ex['glYa2-Y8yEI'], 'saved-for-later NOT excluded');
});

test('picks: max 5, verified only, no excluded, partial never picked', async () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  const r = await pickForMe({}, '', RECIPES, ex);
  assert.ok(r.count <= 5);
  const names = r.picks.map((p) => p.name).join('|');
  assert.ok(!/Onion Rava Dosa|Soya Chukka/.test(names), 'excluded dishes not picked');
  assert.ok(!/Protein Mixture/.test(names), 'partial-verified never picked');
  assert.ok(r.count > 0, 'recipes remain after exclusion');
  assert.equal(r.usedAI, false);
});

test('one pick per video: dish + side from the same video take one slot', async () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  const r = await pickForMe({}, '', RECIPES, ex);
  const vids = r.picks.map((p) => videoIdOf(p.url));
  assert.equal(new Set(vids).size, vids.length, 'no duplicate video IDs');
  const names = r.picks.map((p) => p.name).join('|');
  assert.ok(!(/Vada Curry/.test(names) && /Set Dosa/.test(names)), 'same-video pair never both picked');
});

test('diet filter: non-veg yields only non-veg recipes', async () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  const r = await pickForMe({ diet: 'Non-veg' }, '', RECIPES, ex);
  assert.ok(r.picks.every((p) => /Omelette|Pancakes/.test(p.name)), 'egg dishes count as non-veg');
  assert.equal(r.count, 2);
});

test('meal filter: breakfast excludes lunch dishes', async () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  const r = await pickForMe({ meal: 'breakfast' }, '', RECIPES, ex);
  const names = r.picks.map((p) => p.name).join('|');
  assert.ok(!/Biriyani|Chukka|Kuzhambu/.test(names));
});

test('honest shortfall note when fewer than 5 qualify', async () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  const r = await pickForMe({ diet: 'Non-veg' }, '', RECIPES, ex);
  assert.match(r.note, /Only 2 verified recipes qualify/);
});

test('AI rankFn: valid indices honored with reasons; junk indices dropped', async () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  const r = await pickForMe({}, '', RECIPES, ex, async (cands) => ({
    order: [2, 0, 99, -1, 2], reasons: { 2: 'fits the note', 0: 'quick' }
  }));
  assert.ok(r.usedAI);
  assert.ok(r.count <= 3, 'only valid unique indices used');
  assert.equal(r.picks[0].reason, 'fits the note');
});

test('AI rankFn failure falls back to unranked, labeled usedAI=false', async () => {
  const ex = excludedIds(HISTORY, PICKS, NOW);
  const r = await pickForMe({}, '', RECIPES, ex, async () => { throw new Error('provider down'); });
  assert.equal(r.usedAI, false);
  assert.ok(r.count > 0);
});

test('diet filter: unknown/unclassified diets are neither veg nor non-veg picks', async () => {
  const rows = [
    { recipe_name: 'Plain Veg', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1', diet: 'Veg', meal_type: 'lunch', verified: 'yes' },
    { recipe_name: 'Mystery Dish', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA2', diet: '', meal_type: 'lunch', verified: 'yes' },
    { recipe_name: 'Unsure Dish', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA3', diet: '?', meal_type: 'lunch', verified: 'yes' },
    { recipe_name: 'Chicken Curry', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA4', diet: 'Non-veg', meal_type: 'lunch', verified: 'yes' },
  ];
  const veg = await pickForMe({ diet: 'Veg' }, '', rows as any, {});
  assert.deepEqual(veg.picks.map((p) => p.name), ['Plain Veg']);
  const nonveg = await pickForMe({ diet: 'Non-veg' }, '', rows as any, {});
  assert.deepEqual(nonveg.picks.map((p) => p.name), ['Chicken Curry']);
  const all = await pickForMe({}, '', rows as any, {});
  assert.equal(all.count, 4, 'unknown diets still appear in an unfiltered pick');
});

test('note "no onion": onion recipes excluded, exclusion reported honestly', async () => {
  const rows = [
    { recipe_name: 'Onion Pakoda', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB1', diet: 'Veg', meal_type: 'snack', ingredients: 'onion, besan, chilli', verified: 'yes' },
    { recipe_name: 'Plain Chips', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB2', diet: 'Veg', meal_type: 'snack', ingredients: 'potato, salt, oil', verified: 'yes' },
  ];
  const r = await pickForMe({ diet: 'Veg' }, 'no onion', rows as any, {});
  assert.deepEqual(r.picks.map((p) => p.name), ['Plain Chips']);
  assert.match(r.noteInfo, /excluded recipes containing "onion"/);
  assert.match(r.noteInfo, /AI ranking is off/);
  assert.equal(r.usedAI, false);
});

test('unparseable note: ignored and reported, picks unchanged', async () => {
  const rows = [
    { recipe_name: 'Plain Chips', video_url: 'https://www.youtube.com/watch?v=CCCCCCCCCC1', diet: 'Veg', meal_type: 'snack', ingredients: 'potato, salt', verified: 'yes' },
  ];
  const r = await pickForMe({}, 'something the kids will love today', rows as any, {});
  assert.equal(r.count, 1);
  assert.match(r.noteInfo, /could not be applied/);
});

test('note "no X or Y": both excluded, later words stay keywords', async () => {
  const rows = [
    { recipe_name: 'Onion Garlic Pakoda', video_url: 'https://www.youtube.com/watch?v=EEEEEEEEEE1', diet: 'Veg', meal_type: 'snack', ingredients: 'onion, garlic, besan', verified: 'yes' },
    { recipe_name: 'Pepper Chips', video_url: 'https://www.youtube.com/watch?v=EEEEEEEEEE2', diet: 'Veg', meal_type: 'snack', ingredients: 'potato, pepper, salt', verified: 'yes' },
    { recipe_name: 'Plain Chips', video_url: 'https://www.youtube.com/watch?v=EEEEEEEEEE3', diet: 'Veg', meal_type: 'snack', ingredients: 'potato, salt', verified: 'yes' },
  ];
  const r = await pickForMe({}, 'no onion or garlic, pepper', rows as any, {});
  const names = r.picks.map((p) => p.name);
  assert.ok(!names.includes('Onion Garlic Pakoda'), 'onion+garlic dish excluded');
  assert.equal(names[0], 'Pepper Chips', 'pepper keyword boosts first');
  assert.match(r.noteInfo, /"onion"/);
  assert.match(r.noteInfo, /"garlic"/);
});

test('positive note keyword: deterministic boost, name match wins', async () => {
  const rows = [
    { recipe_name: 'Vegetable Kurma', video_url: 'https://www.youtube.com/watch?v=DDDDDDDDDD1', diet: 'Veg', meal_type: 'lunch', ingredients: 'mixed vegetables, coconut', verified: 'yes' },
    { recipe_name: 'Pepper Rasam', video_url: 'https://www.youtube.com/watch?v=DDDDDDDDDD2', diet: 'Veg', meal_type: 'lunch', ingredients: 'pepper, tamarind, tomato', verified: 'yes' },
    { recipe_name: 'Curd Rice', video_url: 'https://www.youtube.com/watch?v=DDDDDDDDDD3', diet: 'Veg', meal_type: 'lunch', ingredients: 'rice, curd', verified: 'yes' },
  ];
  const r = await pickForMe({}, 'pepper', rows as any, {});
  assert.deepEqual(r.picks.map((p) => p.name), ['Pepper Rasam'], 'note keyword is a hard filter, not a boost');
  assert.match(r.noteInfo, /match "pepper"/);
});

test('note "bread" + veg + snack: only bread recipes returned, never an unrelated snack', async () => {
  const rows = [
    { recipe_name: 'Medu Vada (ulundu vadai, mixer method)', video_url: 'https://www.youtube.com/watch?v=FFFFFFFFFF1', diet: 'Veg', meal_type: 'Breakfast / evening snack', ingredients: 'urad dal, pepper, curry leaves, oil', verified: 'yes' },
    { recipe_name: 'Besan Bread Toast', video_url: 'https://www.youtube.com/watch?v=FFFFFFFFFF2', diet: 'Veg', meal_type: 'Evening snack or breakfast', ingredients: 'bread slices, besan, onion, tomato', verified: 'yes' },
  ];
  const r = await pickForMe({ diet: 'Veg', meal: 'snack' }, 'bread', rows as any, {});
  assert.deepEqual(r.picks.map((p) => p.name), ['Besan Bread Toast']);
  assert.match(r.noteInfo, /match "bread"/);
});

test('note keyword nothing matches: honest zero, no filler', async () => {
  const rows = [
    { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=FFFFFFFFFF3', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal, oil', verified: 'yes' },
  ];
  const r = await pickForMe({}, 'pasta', rows as any, {});
  assert.equal(r.count, 0);
  assert.match(r.noteInfo, /no verified recipe matches "pasta"/);
});
