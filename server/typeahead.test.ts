import test from 'node:test';
import assert from 'node:assert/strict';
// The shared typeahead helpers live with the web app so the ingredient AND
// dish filters use one implementation; tested here from the server suite.
import { taFilter, taNav, toggleSel, composePickNote, hasAskInput } from '../web/src/ta.js';

test('taFilter: prefix matches rank before inner matches, max 6, min 2 chars', () => {
  const vocab = ['Pongal', 'Ven Pongal', 'Poli', 'Paruppu Poli', 'Tomato Pongal', 'Podi', 'Paniyaram', 'Paneer Butter Masala'];
  assert.deepEqual(taFilter(vocab, 'p'), [], 'single char never suggests');
  assert.deepEqual(taFilter(vocab, ''), [], 'empty never suggests');
  const po = taFilter(vocab, 'po');
  assert.deepEqual(po.slice(0, 3), ['Pongal', 'Poli', 'Podi'], 'prefix matches first, vocab order kept');
  assert.ok(po.includes('Ven Pongal') && po.includes('Tomato Pongal'), 'inner matches follow');
  assert.ok(po.length <= 6, 'capped at 6');
  const seven = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'ab'];
  assert.equal(taFilter(seven, 'a').length, 0, 'min token is 2');
  assert.equal(taFilter(seven, 'a1').length, 1);
  assert.deepEqual(taFilter(['Xyz'], 'zz'), [], 'no match -> empty list (drives the no-matches state)');
  assert.deepEqual(taFilter(vocab, 'PON'), taFilter(vocab, 'pon'), 'case-insensitive token');
  assert.deepEqual(taFilter(vocab, '  poli '), ['Poli', 'Paruppu Poli'], 'token trimmed; display case preserved');
});

test('taNav: arrows wrap, Enter/Tab pick the active row, other keys pass through', () => {
  assert.deepEqual(taNav('ArrowDown', 0, 3), { type: 'move', index: 1 });
  assert.deepEqual(taNav('ArrowDown', 2, 3), { type: 'move', index: 0 }, 'down wraps to top');
  assert.deepEqual(taNav('ArrowUp', 0, 3), { type: 'move', index: 2 }, 'up wraps to bottom');
  assert.deepEqual(taNav('Enter', 1, 3), { type: 'pick', index: 1 });
  assert.deepEqual(taNav('Tab', 2, 3), { type: 'pick', index: 2 });
  assert.equal(taNav('a', 0, 3), null, 'typing is not navigation');
  assert.equal(taNav('ArrowDown', 0, 0), null, 'empty list: nothing to move or pick');
  assert.equal(taNav('Enter', 0, 0), null, 'empty list: Enter never picks a phantom row');
});

test('toggleSel: check adds once, uncheck removes - chips and checkbox lists share it', () => {
  assert.deepEqual(toggleSel([], 'pongal'), ['pongal'], 'check adds');
  assert.deepEqual(toggleSel(['pongal'], 'pongal'), [], 'uncheck removes');
  assert.deepEqual(toggleSel(['pongal'], 'pongal'.toUpperCase()), ['pongal', 'PONGAL'], 'exact-string identity, no silent merge');
  const twice = toggleSel(toggleSel([], 'rice'), 'rice');
  assert.deepEqual(twice, [], 'toggle twice returns to empty - no duplicate possible');
});

// Typed dish text must reach the pick/ask request: the dish select list is
// optional, so a typed-but-unselected entry (an ingredient like beetroot,
// or any dish name) is searched instead of silently dropped (prod incident:
// user typed "beetroot", request went out with dishes:[] note:"").
test('composePickNote: typed dish alone is transmitted', () => {
  assert.equal(composePickNote([], '', 'beetroot'), 'beetroot');
  assert.equal(composePickNote([], 'quick', 'ven pongal'), 'ven pongal - quick');
});
test('composePickNote: ingredient chips lead, typed dish follows, free note last', () => {
  assert.equal(composePickNote(['paneer'], 'no onion', 'beetroot'), 'paneer, beetroot - no onion');
});
test('composePickNote: empty/blank typed dish changes nothing', () => {
  assert.equal(composePickNote([], '', ''), '');
  assert.equal(composePickNote(['paneer'], 'quick', '   '), 'paneer - quick');
  assert.equal(composePickNote([], 'for kids', ''), 'for kids');
});
test('composePickNote: chip and identical typed text dedup case-insensitively', () => {
  assert.equal(composePickNote(['Beetroot'], '', 'beetroot'), 'Beetroot');
  assert.equal(composePickNote([], 'beetroot', 'beetroot'), 'beetroot');
});

test('hasAskInput: typed dish enables Ask even with nothing else set', () => {
  assert.equal(hasAskInput('', [], [], 'beetroot'), true);
  assert.equal(hasAskInput('', [], [], ''), false);
  assert.equal(hasAskInput('quick', [], [], ''), true);
  assert.equal(hasAskInput('', ['paneer'], [], ''), true);
  assert.equal(hasAskInput('', [], ['ven pongal'], ''), true);
  assert.equal(hasAskInput('  ', [], [], '  '), false);
});
