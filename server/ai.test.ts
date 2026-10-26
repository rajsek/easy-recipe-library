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

test('structured answer: valid ids return text + canonical recipe cards', async () => {
  const chat = async () => ({ text: '{"text":"Try **Besan Bread Toast** - quick and veg.","ids":[1]}', meta: { provider: 'mock', model: 'mock', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  const out = await askWithValidation(chat, rows.slice(0, 1), 'quick snack?', {});
  assert.equal(out.text, 'Try Besan Bread Toast - quick and veg.', 'markdown wrappers stripped from prose');
  assert.deepEqual(out.recipes.map((r) => r.recipe_name), ['Besan Bread Toast'], 'canonical row resolved from the cited id');
});

test('structured answer: ids outside the candidate list are retried once, then rejected', async () => {
  let calls = 0;
  const chat = async () => { calls++; return { text: '{"text":"How about Chicken Tikka?","ids":[9]}', meta: { provider: 'mock', model: 'mock', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }; };
  await assert.rejects(
    askWithValidation(chat, rows.slice(0, 1), 'dinner idea?', {}),
    /reference validation/,
    'a reference the server cannot resolve must never reach the user'
  );
  assert.equal(calls, 2, 'one corrective retry before rejecting');
});

test('structured answer: non-JSON replies are retried once, then rejected', async () => {
  let calls = 0;
  const chat = async () => { calls++; return { text: 'Just make pasta!', meta: { provider: 'mock', model: 'mock', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }; };
  await assert.rejects(askWithValidation(chat, rows.slice(0, 1), 'dinner idea?', {}), /reference validation/);
  assert.equal(calls, 2);
});

test('corrective retry succeeds when the model fixes its ids', async () => {
  let calls = 0;
  const chat = async () => { ++calls; return { text: calls === 1 ? '{"text":"Maybe pasta?","ids":[7]}' : '{"text":"Better: Besan Bread Toast.","ids":[1]}', meta: { provider: 'mock', model: 'mock', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }; };
  const out = await askWithValidation(chat, rows.slice(0, 1), 'dinner idea?', {});
  assert.equal(out.text, 'Better: Besan Bread Toast.');
  assert.equal(out.recipes.length, 1);
  assert.equal(calls, 2);
});

test('structured answer: prose naming an uncited recipe carries no card', async () => {
  const chat = async () => ({ text: '{"text":"You could improvise a pizza, but from your library: Besan Bread Toast.","ids":[1]}', meta: { provider: 'mock', model: 'mock', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } });
  const out = await askWithValidation(chat, rows.slice(0, 1), 'dinner idea?', {});
  assert.deepEqual(out.recipes.map((r) => r.recipe_name), ['Besan Bread Toast'], 'only cited ids render as library cards');
});

test('ask under Veg filter: the model only ever receives veg candidates', async () => {
  let sawEgg = false;
  const chat = async (prompt: string) => { sawEgg = /Spicy Egg Omelette/.test(prompt); return { text: '{"text":"ok","ids":[]}', meta: { provider: 'mock', model: 'mock', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }; };
  const candidates = filterCandidateRecipes(rows, { diet: 'Veg' });
  await askWithValidation(chat, candidates, 'any snack?', { diet: 'Veg' });
  assert.equal(sawEgg, false, 'egg dish must not even reach the prompt under Veg');
});



import { constrainAskCandidates } from './pick.js';

const askRows = [
  { recipe_name: 'Besan Bread Toast', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB1', diet: 'Veg', meal_type: 'snack, breakfast', ingredients: 'bread, besan', verified: 'yes' },
  { recipe_name: 'Peanut Chutney', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB2', diet: 'Veg', meal_type: 'side', ingredients: 'peanut, chilli', verified: 'yes' },
  { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=BBBBBBBBBB3', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal', verified: 'yes' },
] as any;

test('ask constraints: bread regression holds - bread question zeros when no bread recipe qualifies', () => {
  const noBread = askRows.filter((r) => r.recipe_name !== 'Besan Bread Toast');
  const r = constrainAskCandidates(noBread, 'which bread recipes do I have?', { titles: {}, videoOnly: {} }, { bread: 'food', recipes: 'unknown', have: 'unknown' });
  assert.equal(r.candidates.length, 0);
  assert.match(r.zeroReason || '', /"bread"/);
});

test('ask constraints: food word hard-filters to matching candidates', () => {
  const r = constrainAskCandidates(askRows, 'any bread snack ideas?', { titles: {}, videoOnly: {} }, { bread: 'food', snack: 'unknown', ideas: 'unknown' });
  assert.deepEqual(r.candidates.map((x) => x.recipe_name), ['Besan Bread Toast']);
});

test('ask constraints: no-repeat hides recent picks UNLESS the question names the dish', () => {
  const ex = { titles: {}, videoOnly: { BBBBBBBBBB1: true } }; // Besan Bread Toast shown in a recent pick (video-level)
  const generic = constrainAskCandidates(askRows, 'what snack should I make?', ex, {});
  assert.ok(!generic.candidates.some((r) => r.recipe_name === 'Besan Bread Toast'), 'hidden in generic ask');
  const direct = constrainAskCandidates(askRows, 'how do I make Besan Bread Toast?', ex, {});
  assert.ok(direct.candidates.some((r) => r.recipe_name === 'Besan Bread Toast'), 'direct question stays answerable');
});

test('ask constraints: "no peanut" exclusion is hard', () => {
  const r = constrainAskCandidates(askRows, 'chutney ideas, no peanut', { titles: {}, videoOnly: {} }, {});
  assert.ok(!r.candidates.some((x) => /peanut/i.test(x.recipe_name)));
});

test('ask constraints: unclassified/mood words never zero a natural question', () => {
  const r = constrainAskCandidates(askRows, 'what is the quickest breakfast?', { titles: {}, videoOnly: {} }, { quickest: 'mood', breakfast: 'unknown' });
  assert.equal(r.candidates.length, 3, 'no hard filter without an explicit food word');
});

test('ask constraints: a suggested dish hides only itself, not sibling dishes from the same video', () => {
  const rows = [
    { recipe_name: 'Onion Rava Dosa (hotel style)', video_url: 'https://www.youtube.com/watch?v=SAMESAMESAM', diet: 'Veg', meal_type: 'breakfast', ingredients: 'rava, rice flour', verified: 'yes' },
    { recipe_name: 'Khara Pudina Chutney (spicy mint chutney for rava dosa)', video_url: 'https://www.youtube.com/watch?v=SAMESAMESAM', diet: 'Veg', meal_type: 'side', ingredients: 'mint, coconut', verified: 'yes' },
  ] as any;
  const ex = { titles: { SAMESAMESAM: ['Onion Rava Dosa (hotel style)'] }, videoOnly: {} };
  const r = constrainAskCandidates(rows, 'which chutney recipes do I have?', ex, { chutney: 'food' });
  assert.deepEqual(r.candidates.map((x) => x.recipe_name), ['Khara Pudina Chutney (spicy mint chutney for rava dosa)'], 'sibling dish stays answerable');
  const dosa = constrainAskCandidates(rows, 'dosa ideas?', ex, {});
  assert.ok(!dosa.candidates.some((x) => /Rava Dosa/.test(x.recipe_name)), 'suggested dish hidden');
  const direct = constrainAskCandidates(rows, 'how do I make Onion Rava Dosa?', ex, {});
  assert.ok(direct.candidates.some((x) => /Rava Dosa/.test(x.recipe_name)), 'direct question answerable');
});

test('ask constraints: question stopwords never become food filters', () => {
  const r = constrainAskCandidates(askRows, 'which chutney recipes do I have?', { titles: {}, videoOnly: {} }, { which: 'food', have: 'food', chutney: 'mood' });
  assert.equal(r.candidates.length, 3, 'stopwords ignored even if the classifier mislabels them');
});

test('ask constraints: inventory lookups bypass no-repeat, recommendations do not', () => {
  const ex = { titles: {}, videoOnly: { BBBBBBBBBB1: true } }; // Besan Bread Toast just suggested
  const lookup = constrainAskCandidates(askRows, 'which bread recipes do I have?', ex, { bread: 'food' });
  assert.deepEqual(lookup.candidates.map((x) => x.recipe_name), ['Besan Bread Toast'], 'owned recipe must show in an inventory answer even when recently suggested');
  const reco = constrainAskCandidates(askRows, 'any bread snack ideas?', ex, { bread: 'food' });
  assert.equal(reco.candidates.length, 0, 'recommendation still hides the just-suggested recipe');
  assert.ok(reco.zeroReason);
});

test('ask constraints: multiple food words are an AND, never a silent OR', () => {
  const rows = [
    { recipe_name: 'Onion Pakoda', video_url: 'https://www.youtube.com/watch?v=IIIIIIIIII1', diet: 'Veg', meal_type: 'snack', ingredients: 'onion, besan', verified: 'yes' },
    { recipe_name: 'Paneer Corn Kebab', video_url: 'https://www.youtube.com/watch?v=IIIIIIIIII2', diet: 'Veg', meal_type: 'snack', ingredients: 'paneer, sweet corn, onion', verified: 'yes' },
    { recipe_name: 'Paneer Toast', video_url: 'https://www.youtube.com/watch?v=IIIIIIIIII3', diet: 'Veg', meal_type: 'snack', ingredients: 'paneer, bread', verified: 'yes' },
  ] as any;
  const r = constrainAskCandidates(rows, 'onion paneer ideas?', { titles: {}, videoOnly: {} }, { onion: 'food', paneer: 'food', ideas: 'unknown' }, undefined, rows);
  assert.deepEqual(r.candidates.map((x) => x.recipe_name), ['Paneer Corn Kebab'], 'only the BOTH recipe survives');
});

test('ask constraints: question word "what" never becomes the ingredient "wheat"', () => {
  const rows = [
    { recipe_name: 'Wheat Pancakes', video_url: 'https://www.youtube.com/watch?v=JJJJJJJJJJ1', diet: 'Veg', meal_type: 'breakfast', ingredients: 'wheat flour, banana', verified: 'yes' },
    { recipe_name: 'Paneer Toast', video_url: 'https://www.youtube.com/watch?v=JJJJJJJJJJ2', diet: 'Veg', meal_type: 'snack', ingredients: 'paneer, bread', verified: 'yes' },
  ] as any;
  const r = constrainAskCandidates(rows, 'what paneer dishes can I make?', { titles: {}, videoOnly: {} }, {}, undefined, rows);
  assert.deepEqual(r.candidates.map((x) => x.recipe_name), ['Paneer Toast'], 'only paneer filters; what stays a question word');
});

test('ask zero reason: no-repeat cause names recent suggestions, not "outside filters"', () => {
  const rows = [
    { recipe_name: 'Paneer Butter Masala', video_url: 'https://www.youtube.com/watch?v=KKKKKKKKKK1', diet: 'Veg', meal_type: 'lunch', ingredients: 'paneer, tomato, cashew', verified: 'yes' },
    { recipe_name: 'Curd Rice', video_url: 'https://www.youtube.com/watch?v=KKKKKKKKKK2', diet: 'Veg', meal_type: 'lunch', ingredients: 'rice, curd', verified: 'yes' },
  ] as any;
  const ex = { titles: {}, videoOnly: { KKKKKKKKKK1: true } }; // suggested yesterday
  const r = constrainAskCandidates(rows, 'paneer ideas?', ex, { paneer: 'food', ideas: 'unknown' }, undefined, rows);
  assert.equal(r.candidates.length, 0);
  assert.match(r.zeroReason || '', /already suggested within the last 30 days/);
  assert.match(r.zeroReason || '', /Paneer Butter Masala/);
  assert.match(r.zeroReason || '', /ask for one by name/);
});

test('ask zero reason: diet/meal cause names the filter, not no-repeat', () => {
  const rows = [
    { recipe_name: 'Peanut Chutney', video_url: 'https://www.youtube.com/watch?v=LLLLLLLLLL1', diet: 'Veg', meal_type: 'side', ingredients: 'peanut, chilli', verified: 'yes' },
    { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=LLLLLLLLLL2', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal', verified: 'yes' },
  ] as any;
  const snackOnly = rows.filter((r) => r.meal_type === 'snack'); // what a meal filter would pass in
  const r = constrainAskCandidates(snackOnly, 'chutney ideas?', { titles: {}, videoOnly: {} }, { chutney: 'food', ideas: 'unknown' }, undefined, rows);
  assert.equal(r.candidates.length, 0);
  assert.match(r.zeroReason || '', /outside your current diet\/meal filters/);
  assert.match(r.zeroReason || '', /Peanut Chutney/);
});

test('ask zero reason: genuine library-wide absence keeps coverage counts', () => {
  const r = constrainAskCandidates(askRows, 'sushi ideas?', { titles: {}, videoOnly: {} }, { sushi: 'food', ideas: 'unknown' }, undefined, askRows);
  assert.equal(r.candidates.length, 0);
  assert.match(r.zeroReason || '', /gap in the checked library/);
});
