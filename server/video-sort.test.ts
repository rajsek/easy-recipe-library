import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVideoRows } from './data.js';

test('video source sorting applies to the full set, no row cap', () => {
  const rows = Array.from({length:350}, (_, i) => ({video_id:String(i),title: i === 349 ? 'AAA highest' : `Other ${i}`,views:i,channel:'A',diet_hint:'veg',category:'snack'}));
  const viewed = selectVideoRows(rows, {sort:'views'});
  assert.equal(viewed.length,350); assert.equal(viewed[0].id,'349');
  assert.equal(selectVideoRows(rows,{sort:'name'})[0].id,'349');
  assert.equal(selectVideoRows(rows,{sort:'unsupported'})[0].id,'0');
  assert.equal(rows[0].video_id,'0');
});
test('source sorting preserves title, channel, diet and category constraints', () => {
  const rows = [
    {video_id:'allowed',title:'Rice dish',views:'10',channel:'A',diet_hint:'veg',category:'snack'},
    {video_id:'wrongdiet',title:'Rice egg',views:'1000',channel:'A',diet_hint:'egg',category:'snack'},
    {video_id:'wrongchannel',title:'Rice dish',views:'2000',channel:'B',diet_hint:'veg',category:'snack'},
    {video_id:'wrongcategory',title:'Rice dish',views:'3000',channel:'A',diet_hint:'veg',category:'sweet'},
    {video_id:'wrongtitle',title:'Soup',views:'4000',channel:'A',diet_hint:'veg',category:'snack'}
  ];
  assert.deepEqual(selectVideoRows(rows,{q:'rice',channel:'A',diet:'veg',category:'snack',sort:'views'}).map(r=>r.id),['allowed']);
});

test('default video order interleaves channels round-robin; explicit original keeps insertion order', () => {
  const rows = [
    {video_id:'a1',title:'A one',channel:'A',diet_hint:'veg',category:'snack'},
    {video_id:'a2',title:'A two',channel:'A',diet_hint:'veg',category:'snack'},
    {video_id:'a3',title:'A three',channel:'A',diet_hint:'veg',category:'snack'},
    {video_id:'b1',title:'B one',channel:'B',diet_hint:'veg',category:'snack'},
    {video_id:'b2',title:'B two',channel:'B',diet_hint:'veg',category:'snack'},
    {video_id:'c1',title:'C one',channel:'C',diet_hint:'veg',category:'snack'}
  ];
  assert.deepEqual(selectVideoRows(rows, {}).map(r=>r.id), ['a1','b1','c1','a2','b2','a3']);
  assert.deepEqual(selectVideoRows(rows, {sort:'mixed'}).map(r=>r.id), ['a1','b1','c1','a2','b2','a3']);
  assert.deepEqual(selectVideoRows(rows, {sort:'original'}).map(r=>r.id), ['a1','a2','a3','b1','b2','c1']);
});
