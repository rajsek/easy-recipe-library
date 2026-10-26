import test from 'node:test';
import assert from 'node:assert/strict';
import { askWithValidation } from './ai.js';
import { filterCandidateRecipes } from './pick.js';

const rows = [
  { recipe_name: 'Besan Bread Toast', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA1', diet: 'Veg', meal_type: 'snack, breakfast', ingredients: 'bread, besan', verified: 'yes' },
  { recipe_name: 'Spicy Egg Omelette', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA2', diet: 'Egg', meal_type: 'breakfast, snack', ingredients: 'egg, onion', verified: 'yes' },
  { recipe_name: 'Mystery Stew', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA3', diet: '', meal_type: 'dinner', ingredients: 'unknown', verified: 'yes' },
  { recipe_name: 'Draft Chutney', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA4', diet: 'Veg', meal_type: 'side', ingredients: 'mint', verified: '' },
] as any;

test('filterCandidateRecipes: verified-only, Veg strict, Non-veg explicit, unknown matches neither', () => {
  const veg = filterCandidateRecipes(rows, { diet: 'Veg' }).map((r) => r.recipe_name);
  assert.deepEqual(veg, ['Besan Bread Toast'], 'egg + unknown + unverified out under Veg');
  const nv = filterCandidateRecipes(rows, { diet: 'Non-veg' }).map((r) => r.recipe_name);
  assert.deepEqual(nv, ['Spicy Egg Omelette'], 'only explicit egg/meat under Non-veg');
  const all = filterCandidateRecipes(rows, {}).map((r) => r.recipe_name);
  assert.deepEqual(all, ['Besan Bread Toast', 'Spicy Egg Omelette', 'Mystery Stew'], 'unverified out, unknown allowed unfiltered');
  const breakfast = filterCandidateRecipes(rows, { diet: 'Veg', meal: 'breakfast' }).map((r) => r.recipe_name);
  assert.deepEqual(breakfast, ['Besan Bread Toast']);
});

test('ask answer with valid [[library names]] passes, markers stripped', async () => {
  const chat = async () => 'Try [[Besan Bread Toast]] - quick and veg.';
  const out = await askWithValidation(chat, rows.slice(0, 1), 'quick snack?', {});
  assert.equal(out, 'Try Besan Bread Toast - quick and veg.');
});

test('ask answer referencing a NON-library recipe is retried, then rejected', async () => {
  let calls = 0;
  const chat = async () => { calls++; return 'How about [[Chicken Tikka]] tonight?'; };
  await assert.rejects(
    askWithValidation(chat, rows.slice(0, 1), 'dinner idea?', {}),
    /outside the library/,
    'non-library reference must never reach the user'
  );
  assert.equal(calls, 2, 'one corrective retry before rejecting');
});

test('corrective retry succeeds when the model fixes its references', async () => {
  let calls = 0;
  const chat = async () => (++calls === 1 ? 'Maybe [[Pasta Alfredo]]?' : 'Better: [[Besan Bread Toast]].');
  const out = await askWithValidation(chat, rows.slice(0, 1), 'dinner idea?', {});
  assert.equal(out, 'Better: Besan Bread Toast.');
  assert.equal(calls, 2);
});

test('ask under Veg filter: the model only ever receives veg candidates', async () => {
  let sawEgg = false;
  const chat = async (prompt: string) => { sawEgg = /Spicy Egg Omelette/.test(prompt); return 'ok'; };
  const candidates = filterCandidateRecipes(rows, { diet: 'Veg' });
  await askWithValidation(chat, candidates, 'any snack?', { diet: 'Veg' });
  assert.equal(sawEgg, false, 'egg dish must not even reach the prompt under Veg');
});

test('long descriptive names: [[Ven Pongal]] matches \"Ven Pongal (Chef Damu style, ...)\" and normalizes', async () => {
  const longRows = [
    { recipe_name: 'Ven Pongal (Chef Damu style, with ulutham paruppu thogayal side)', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA5', diet: 'Veg', meal_type: 'breakfast', ingredients: 'rice, dal', verified: 'yes' },
  ] as any;
  const chat = async () => 'For breakfast try [[Ven Pongal]].';
  const out = await askWithValidation(chat, longRows, 'breakfast?', { diet: 'Veg' });
  assert.equal(out, 'For breakfast try Ven Pongal (Chef Damu style, with ulutham paruppu thogayal side).');
});

test('ambiguous prefix shared by two recipes is accepted for NEITHER', async () => {
  const twoRows = [
    { recipe_name: 'Tomato Rice (Hema style)', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA6', diet: 'Veg', meal_type: 'lunch', ingredients: 'rice', verified: 'yes' },
    { recipe_name: 'Tomato Rice (Chef Damu style)', video_url: 'https://www.youtube.com/watch?v=AAAAAAAAAA7', diet: 'Veg', meal_type: 'lunch', ingredients: 'rice', verified: 'yes' },
  ] as any;
  const chat = async () => 'Have [[Tomato Rice]] for lunch.';
  await assert.rejects(askWithValidation(chat, twoRows, 'lunch?', {}), /outside the library/);
});

import { constrainAskCandidates } from './pick.js';

const askRows = [
  { recipe_name: 'Besan Bread Toast', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB1', diet: 'Veg', meal_type: 'snack, breakfast', ingredients: 'bread, besan', verified: 'yes' },
  { recipe_name: 'Peanut Chutney', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB2', diet: 'Veg', meal_type: 'side', ingredients: 'peanut, chilli', verified: 'yes' },
  { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB3', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal', verified: 'yes' },
] as any;

test('ask constraints: bread regression holds - bread question zeros when no bread recipe qualifies', () => {
  const noBread = askRows.filter((r) => r.recipe_name !== 'Besan Bread Toast');
  const r = constrainAskCandidates(noBread, 'which bread recipes do I have?', {}, { bread: 'food', recipes: 'unknown', have: 'unknown' });
  assert.equal(r.candidates.length, 0);
  assert.match(r.zeroReason || '', /"bread"/);
});

test('ask constraints: food word hard-filters to matching candidates', () => {
  const r = constrainAskCandidates(askRows, 'any bread snack ideas?', {}, { bread: 'food', snack: 'unknown', ideas: 'unknown' });
  assert.deepEqual(r.candidates.map((x) => x.recipe_name), ['Besan Bread Toast']);
});

test('ask constraints: no-repeat hides recent picks UNLESS the question names the dish', () => {
  const ex = { BBBBBBBBBB1: true }; // Besan Bread Toast suggested recently
  const generic = constrainAskCandidates(askRows, 'what snack should I make?', ex, {});
  assert.ok(!generic.candidates.some((r) => r.recipe_name === 'Besan Bread Toast'), 'hidden in generic ask');
  const direct = constrainAskCandidates(askRows, 'how do I make Besan Bread Toast?', ex, {});
  assert.ok(direct.candidates.some((r) => r.recipe_name === 'Besan Bread Toast'), 'direct question stays answerable');
});

test('ask constraints: "no peanut" exclusion is hard', () => {
  const r = constrainAskCandidates(askRows, 'chutney ideas, no peanut', {}, {});
  assert.ok(!r.candidates.some((x) => /peanut/i.test(x.recipe_name)));
});

test('ask constraints: unclassified/mood words never zero a natural question', () => {
  const r = constrainAskCandidates(askRows, 'what is the quickest breakfast?', {}, { quickest: 'mood', breakfast: 'unknown' });
  assert.equal(r.candidates.length, 3, 'no hard filter without an explicit food word');
});
