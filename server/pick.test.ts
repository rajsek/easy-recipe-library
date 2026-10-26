import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickForMe, excludedIds, videoIdOf, constrainAskCandidates, typeaheadVocab } from './pick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const demo = JSON.parse(readFileSync(path.join(__dirname, 'test-fixtures.json'), 'utf8'));

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
  assert.match(r.noteInfo, /no verified recipe matches everything/);
  assert.match(r.noteInfo, /0 list "pasta"/);
  assert.match(r.noteInfo, /gap in the checked library, not proof the dish does not exist/);
});

test('word boundaries: "breadless" title does not satisfy "bread"; exclusion "no corn" spares "popcorn"', async () => {
  const rows = [
    { recipe_name: 'Breadless Besan Toast', video_url: 'https://www.youtube.com/watch?v=GGGGGGGGGG1', diet: 'Veg', meal_type: 'snack', ingredients: 'besan, onion, tomato', verified: 'yes' },
    { recipe_name: 'Real Bread Toast', video_url: 'https://www.youtube.com/watch?v=GGGGGGGGGG2', diet: 'Veg', meal_type: 'snack', ingredients: 'bread slices, besan', verified: 'yes' },
    { recipe_name: 'Popcorn Bowl', video_url: 'https://www.youtube.com/watch?v=GGGGGGGGGG3', diet: 'Veg', meal_type: 'snack', ingredients: 'popcorn, salt', verified: 'yes' },
    { recipe_name: 'Corn Cutlet', video_url: 'https://www.youtube.com/watch?v=GGGGGGGGGG4', diet: 'Veg', meal_type: 'snack', ingredients: 'sweet corn, potato', verified: 'yes' },
  ];
  const r = await pickForMe({}, 'bread', rows as any, {});
  assert.deepEqual(r.picks.map((p) => p.name), ['Real Bread Toast'], 'breadless does not count as bread');
  const r2 = await pickForMe({}, 'no corn', rows as any, {});
  const names2 = r2.picks.map((p) => p.name);
  assert.ok(!names2.includes('Corn Cutlet'), 'corn excluded');
  assert.ok(names2.includes('Popcorn Bowl'), 'popcorn not caught by no corn');
});

test('AI on + keyword nothing mentions: ranker interprets the note instead of zeroing', async () => {
  const rows = [
    { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH1', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal, oil', verified: 'yes' },
    { recipe_name: 'Fruit Salad', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH2', diet: 'Veg', meal_type: 'snack', ingredients: 'apple, banana', verified: 'yes' },
  ];
  // candidates are shuffled before ranking, so the stub must locate by name
  const rankFn = async (cands: any[]) => {
    const fi = cands.findIndex((c) => c.recipe_name === 'Fruit Salad');
    const order = [fi, ...cands.map((_, i) => i).filter((i) => i !== fi)];
    return { order, reasons: { [fi]: 'lighter option' } };
  };
  const classifyFn = async () => ({ light: 'mood' as const });
  const r = await pickForMe({}, 'something light', rows as any, {}, rankFn, classifyFn);
  assert.equal(r.usedAI, true);
  assert.equal(r.picks[0].name, 'Fruit Salad');
  assert.match(r.noteInfo, /ranked by meaning/);
  assert.equal(r.count, 2, 'no zeroing when AI can interpret');
});

test('no-repeat emptied the pool: message says why, not a bare zero', async () => {
  const rows = [
    { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH1', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal', verified: 'yes' },
  ];
  const r = await pickForMe({}, '', rows as any, { HHHHHHHHHH1: true });
  assert.equal(r.count, 0);
  assert.match(r.note, /already suggested in the last 30 days/);
  assert.doesNotMatch(r.note, /no filler/);
  assert.doesNotMatch(r.noteInfo, /ranked by meaning\./);
});

const hardRows = [
  { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH1', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal, oil', verified: 'yes' },
  { recipe_name: 'Fruit Salad', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH2', diet: 'Veg', meal_type: 'snack', ingredients: 'apple, banana', verified: 'yes' },
];
const moodRank: any = async (cands: any[]) => ({ order: cands.map((_, i) => i), reasons: {} });

test('unmatched FOOD word stays a hard constraint even with AI on ("with tofu")', async () => {
  const classifyFn = async () => ({ tofu: 'food' as const });
  const r = await pickForMe({}, 'with tofu', hardRows as any, {}, moodRank, classifyFn);
  assert.equal(r.count, 0, 'tofu is an ingredient: honest zero, never unrelated fallback');
  assert.match(r.noteInfo, /no verified recipe matches everything/);
  assert.match(r.noteInfo, /0 list "tofu"/);
});

test('unmatched FOOD word stays hard ("using pasta")', async () => {
  const classifyFn = async () => ({ pasta: 'food' as const });
  const r = await pickForMe({}, 'using pasta', hardRows as any, {}, moodRank, classifyFn);
  assert.equal(r.count, 0);
  assert.match(r.noteInfo, /"pasta"/);
});

test('mixed mood + unmatched ingredient still zeros on the ingredient', async () => {
  const classifyFn = async () => ({ light: 'mood' as const, pasta: 'food' as const });
  const r = await pickForMe({}, 'light pasta', hardRows as any, {}, moodRank, classifyFn);
  assert.equal(r.count, 0);
});

test('classifier failure is conservative: zero, not semantic fallback', async () => {
  const classifyFn = async () => { throw new Error('provider down'); };
  const r = await pickForMe({}, 'something light', hardRows as any, {}, moodRank, classifyFn);
  assert.equal(r.count, 0);
  assert.match(r.noteInfo, /no verified recipe matches everything/);
  assert.match(r.noteInfo, /0 list "light"/);
});

test('exclusions are hard regardless of classifier ("no peanut", "without milk")', async () => {
  const rows = [
    { recipe_name: 'Peanut Chutney', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH3', diet: 'Veg', meal_type: 'side', ingredients: 'peanut, chilli', verified: 'yes' },
    { recipe_name: 'Fruit Salad', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH2', diet: 'Veg', meal_type: 'snack', ingredients: 'apple, banana, milk', verified: 'yes' },
  ];
  const r1 = await pickForMe({}, 'no peanut', rows as any, {}, moodRank, async () => ({}));
  assert.ok(!r1.picks.some((p) => /peanut/i.test(p.name)), 'peanut excluded');
  const r2 = await pickForMe({}, 'without milk', rows as any, {}, moodRank, async () => ({}));
  assert.ok(!r2.picks.some((p) => /milk/i.test(p.name)), 'milk excluded');
});

test('veg filter never returns egg-classified cards ("Contains egg"/"Egg")', async () => {
  const ex = excludedIds([], [], NOW);
  const r = await pickForMe({ diet: 'Veg' }, '', RECIPES, ex);
  const names = r.picks.map((p) => p.name).join('|');
  assert.ok(!/Pancakes|Omelette/.test(names), 'egg-classified cards stay out of veg picks');
  const eggRows = RECIPES.filter((x) => /egg/i.test(String(x.diet))).map((x) => x.recipe_name);
  assert.ok(r.picks.every((p) => !eggRows.includes(p.name)), 'no egg-classified row in veg picks');
});

test('data hygiene: a card tagged Veg must never list egg in its ingredients', () => {
  const bad = RECIPES.filter(
    (x) => String(x.diet).trim().toLowerCase() === 'veg' && /\beggs?\b/i.test(String(x.ingredients))
  );
  assert.deepEqual(bad.map((b) => b.recipe_name), [], 'Veg-tagged cards containing egg: ' + bad.map((b) => b.recipe_name).join(','));
});

test('typo tolerance: "panner" normalizes to "paneer" (source-backed alias), visibly interpreted', async () => {
  const ex = excludedIds([], [], NOW);
  const r = await pickForMe({ diet: 'Veg', meal: 'snack' }, 'onion, panner', RECIPES, ex);
  assert.deepEqual(r.interpreted, [{ from: 'panner', to: 'paneer' }]);
  assert.ok(/paneer/.test(r.noteInfo), 'note info names the normalized word');
});

test('typo tolerance: unambiguous edit-distance-1 typo normalizes to the library word', async () => {
  const ex = excludedIds([], [], NOW);
  const r = await pickForMe({ diet: 'Veg' }, 'onin', RECIPES, ex);
  assert.deepEqual(r.interpreted, [{ from: 'onin', to: 'onion' }]);
  assert.ok(r.count > 0, 'onion typo still matches onion recipes');
  assert.ok(/match "onion"/.test(r.noteInfo), 'normalized word visible: ' + r.noteInfo);
});

test('typo ambiguity never guesses: word stays as written and yields an honest zero', async () => {
  const { normalizeNoteWord } = await import('./pick.js');
  const n = normalizeNoteWord('chill', ['chili', 'chilli', 'salt']);
  assert.equal(n.word, 'chill');
  assert.equal(n.interpreted, undefined);
});

test('typo tolerance: no normalization for short words, unknown words, or words already in the library', async () => {
  const { normalizeNoteWord } = await import('./pick.js');
  assert.equal(normalizeNoteWord('soy', ['soya']).word, 'soy');
  assert.equal(normalizeNoteWord('quinoa', ['onion', 'paneer']).word, 'quinoa');
  assert.equal(normalizeNoteWord('onion', ['onion', 'paneer']).word, 'onion');
});

test('note keywords are ANDed and say so plainly: "onion, panner" means BOTH, typo interpreted', async () => {
  const rows = [
    { recipe_name: 'Onion Pakoda', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH1', diet: 'Veg', meal_type: 'snack', ingredients: 'onion, besan, chilli', verified: 'yes' },
    { recipe_name: 'Paneer Corn Kebab', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH2', diet: 'Veg', meal_type: 'snack', ingredients: 'paneer, sweet corn, onion, besan', verified: 'yes' },
    { recipe_name: 'Paneer Toast', video_url: 'https://www.youtube.com/watch?v=HHHHHHHHHH3', diet: 'Veg', meal_type: 'snack', ingredients: 'paneer, bread', verified: 'yes' },
  ];
  const ex = excludedIds([], [], NOW);
  const r = await pickForMe({ diet: 'Veg', meal: 'snack' }, 'onion, panner', rows as any, ex);
  assert.deepEqual(r.picks.map((p) => p.name), ['Paneer Corn Kebab'], 'only the recipe with BOTH onion and paneer survives');
  assert.deepEqual(r.interpreted, [{ from: 'panner', to: 'paneer' }]);
  assert.ok(/interpreted "panner" as "paneer"/.test(r.noteInfo), 'interpretation visible');
  assert.ok(/match every one of "onion", "paneer"/.test(r.noteInfo), 'AND wording is explicit: ' + r.noteInfo);
});

test('a question word is never interpreted as an ingredient: "what" is not "wheat"', async () => {
  const { normalizeNoteWord } = await import('./pick.js');
  const n = normalizeNoteWord('what', ['wheat', 'onion']);
  assert.equal(n.word, 'what');
  assert.equal(n.interpreted, undefined);
  assert.equal(normalizeNoteWord('when', ['whey', 'onion']).word, 'when');
  assert.equal(normalizeNoteWord('meal', ['meat', 'onion']).word, 'meal');
});

test('no-match wording is transparent: coverage counts, interpretation, library-gap honesty', async () => {
  const ex = excludedIds([], [], NOW);
  const r = await pickForMe({ diet: 'Veg', meal: 'snack' }, 'panner', RECIPES, ex);
  assert.equal(r.count, 0, 'no veg snack lists paneer in demo data');
  assert.ok(/interpreted "panner" as "paneer"/.test(r.noteInfo), 'interpretation visible');
  assert.ok(/checked \d+ verified Veg snack recipes: 0 list "paneer"/.test(r.noteInfo), 'deterministic coverage counts: ' + r.noteInfo);
  assert.ok(/gap in the checked library, not proof the dish does not exist/.test(r.noteInfo), 'gap-not-impossibility wording');
});

test('ask route: typo normalized to a library ingredient is a hard food constraint without the classifier', async () => {
  const { constrainAskCandidates, noteVocab } = await import('./pick.js');
  const vocab = noteVocab(RECIPES);
  const { candidates, zeroReason, interpreted } = constrainAskCandidates(RECIPES, 'something with onin please', { titles: {}, videoOnly: {} }, {}, vocab);
  assert.deepEqual(interpreted, [{ from: 'onin', to: 'onion' }]);
  assert.ok(!zeroReason, 'onion typo still matches onion recipes');
  assert.ok(candidates.every((c) => /onion/i.test(c.recipe_name + ' ' + c.ingredients)), 'only onion-matching candidates survive');
});

test('ask route zero: coverage + interpretation in the reason', async () => {
  const { constrainAskCandidates, noteVocab } = await import('./pick.js');
  const vocab = noteVocab(RECIPES);
  const { candidates, zeroReason, interpreted } = constrainAskCandidates(RECIPES, 'snack with panner', { titles: {}, videoOnly: {} }, {}, vocab);
  assert.equal(candidates.length, 0);
  assert.deepEqual(interpreted, [{ from: 'panner', to: 'paneer' }]);
  assert.ok(/0 list "paneer"/.test(zeroReason || ''), zeroReason);
  assert.ok(/gap in the checked library/.test(zeroReason || ''), zeroReason);
});

test('dietClass: "Veg (needs eggless mayo dip)" is veg-conditional - excluded from BOTH Veg and Non-veg picks', async () => {
  const { dietClass, filterCandidateRecipes } = await import('./pick.js');
  assert.equal(dietClass('Veg (needs eggless mayo dip)'), 'veg-conditional');
  const rows = [
    { recipe_name: 'Plain Salad', video_url: 'https://www.youtube.com/watch?v=JJJJJJJJJJ1', diet: 'Veg', meal_type: 'side', ingredients: 'cucumber, tomato', verified: 'yes' },
    { recipe_name: 'Mayo Chips', video_url: 'https://www.youtube.com/watch?v=JJJJJJJJJJ2', diet: 'Veg (needs eggless mayo dip)', meal_type: 'side', ingredients: 'potato; dip: mayonnaise', verified: 'yes' },
  ];
  const veg = filterCandidateRecipes(rows as any, { diet: 'Veg' }).map((r) => r.recipe_name);
  const nonveg = filterCandidateRecipes(rows as any, { diet: 'Non-veg' }).map((r) => r.recipe_name);
  assert.deepEqual(veg, ['Plain Salad'], 'conditional card stays out of strict Veg picks');
  assert.deepEqual(nonveg, [], 'conditional card is not Non-veg either');
  assert.equal(filterCandidateRecipes(rows as any, {}).length, 2, 'both visible unfiltered');
});

test('ask constraints: diet vocabulary in a question is a request word, never an ingredient filter', () => {
  const candidates = [
    { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=CCCCCCCCCC1', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal, salt', verified: 'yes' },
  ] as any;
  const { candidates: out, zeroReason } = constrainAskCandidates(candidates, 'quick veg snack idea?', { titles: {}, videoOnly: {} }, { quick: 'mood' });
  assert.equal(zeroReason, undefined, 'the word veg must not zero the pool');
  assert.equal(out.length, 1);
});

test('ask constraints: a library ingredient stays a hard filter even with NO classifier result', () => {
  const paneer = [
    { recipe_name: 'Paneer Butter Masala', video_url: 'https://www.youtube.com/watch?v=DDDDDDDDDD1', diet: 'Veg', meal_type: 'lunch/dinner', ingredients: 'paneer, butter, tomato', verified: 'yes' },
    { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=DDDDDDDDDD2', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal', verified: 'yes' },
  ] as any;
  const snackPool = paneer.filter((r) => r.meal_type === 'snack');
  // Classifier returned NOTHING (provider failure): paneer must still hard-filter.
  const { zeroReason } = constrainAskCandidates(snackPool, 'paneer snacks?', { titles: {}, videoOnly: {} }, {}, undefined, paneer);
  assert.match(String(zeroReason), /outside your current diet\/meal filters/, 'qualified absence: none under these filters');
  assert.match(String(zeroReason), /Paneer Butter Masala/, 'names the out-of-filter recipes the library does have');
});

test('ask constraints: library-wide absence stays an honest gap, never a recipe claim', () => {
  const pool = [
    { recipe_name: 'Medu Vada', video_url: 'https://www.youtube.com/watch?v=EEEEEEEEEE1', diet: 'Veg', meal_type: 'snack', ingredients: 'urad dal', verified: 'yes' },
  ] as any;
  const { zeroReason } = constrainAskCandidates(pool, 'quinoa salad?', { titles: {}, videoOnly: {} }, { quinoa: 'food' }, undefined, pool); // classifier identifies the unknown word as food; library lists none
  assert.match(String(zeroReason), /not proof the dish does not exist/);
});

test('typeaheadVocab: phrases detected, singles kept, phrase-only parts dropped, unverified excluded', () => {
  const rows = [
    { recipe_name: 'A', video_url: 'u1', diet: 'Veg', meal_type: 'snack', ingredients: '200g paneer, 1 tsp garam masala, salt, coriander leaves', verified: 'yes' },
    { recipe_name: 'B', video_url: 'u2', diet: 'Veg', meal_type: 'snack', ingredients: '100g tofu, 1 tsp garam masala, 2 green chillies, onion', verified: 'yes' },
    { recipe_name: 'C', video_url: 'u3', diet: 'Veg', meal_type: 'snack', ingredients: 'secret spice', verified: 'no' },
  ] as any;
  const v = typeaheadVocab(rows);
  assert.ok(v.includes('garam masala'), 'phrase detected');
  assert.ok(v.includes('green chillies'), 'plural phrase detected');
  assert.ok(v.includes('paneer') && v.includes('tofu') && v.includes('onion'), 'singles kept');
  assert.ok(!v.includes('garam') && !v.includes('masala'), 'phrase-only parts dropped');
  assert.ok(!v.includes('secret'), 'unverified row excluded');
  assert.deepEqual([...v].sort(), v, 'sorted');
});

test('post-output validation: an AI reason that denies a hard note word is hidden', async () => {
  const rows = [
    { recipe_name: 'Crispy Chips', video_url: 'https://www.youtube.com/watch?v=vkREli-0Z9Y',
      channel: 'X', diet: 'Veg', meal_type: 'Evening snack', time_notes: '',
      ingredients: 'potatoes, salt, vinegar, corn starch, olive oil', steps: 's', source_note: '', verified: 'yes', date_checked: '' }
  ];
  const rankFn = async () => ({ order: [0], reasons: ['Only available recipe, but does not contain corn'] });
  const r = await pickForMe({}, 'corn', rows as any, {}, rankFn as any);
  assert.equal(r.picks.length, 1, 'deterministic corn match stands (corn starch is corn)');
  assert.equal(r.picks[0].reason, '', 'false denial reason hidden');
  assert.ok(/hidden because it contradicted/i.test(r.noteInfo), 'noteInfo discloses the hidden reason');
});

test('post-output validation: a truthful reason survives', async () => {
  const rows = [
    { recipe_name: 'Crispy Chips', video_url: 'https://www.youtube.com/watch?v=vkREli-0Z9Y',
      channel: 'X', diet: 'Veg', meal_type: 'Evening snack', time_notes: '',
      ingredients: 'potatoes, salt, vinegar, corn starch, olive oil', steps: 's', source_note: '', verified: 'yes', date_checked: '' }
  ];
  const rankFn = async () => ({ order: [0], reasons: ['Crispy snack, corn starch gives the crunch'] });
  const r = await pickForMe({}, 'corn', rows as any, {}, rankFn as any);
  assert.equal(r.picks[0].reason, 'Crispy snack, corn starch gives the crunch');
  assert.ok(!/hidden/i.test(r.noteInfo));
});
