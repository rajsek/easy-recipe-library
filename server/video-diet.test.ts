import test from 'node:test';
import assert from 'node:assert/strict';
import { videoDietHint, videoMatchesDiet } from './video-diet.js';
import { selectVideoRows } from './data.js';
test('English/German explicit egg evidence overrides incorrect veg hint across listing and filtering',()=>{
  for(const title of ['Wenn Sie 2 Kartoffeln und 1 Ei haben','Kartoffeln und 3 Eier','Potatoes with 1 egg','Spicy omelette']){
    assert.equal(videoDietHint(title,'veg'),'Contains egg');
    assert.equal(videoMatchesDiet(title,'veg','Veg'),false);
    assert.equal(videoMatchesDiet(title,'veg','Contains egg'),true);
    assert.deepEqual(selectVideoRows([{title,diet_hint:'veg'}],{diet:'veg'}),[]);
  }
});
test('unknowns never become veg; eggless wording alone is not egg evidence',()=>{
  for(const title of ['Eggless cake','egg-free cake','cake without eggs','cake with no egg','Kuchen ohne Eier','Kuchen ohne Ei'])assert.equal(videoDietHint(title,'veg'),'veg',title);
  assert.equal(videoMatchesDiet('Potato dish','','veg'),false);
  assert.equal(videoMatchesDiet('Potato dish','unknown','veg'),false);
  assert.equal(videoMatchesDiet('Chicken potato','veg','veg'),false);
  assert.equal(videoDietHint('Chicken and eggs','veg'),'non-veg');
});
