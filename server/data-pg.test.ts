import test from 'node:test';
import assert from 'node:assert/strict';
import { PG_TABS, buildInsert, rowsToObjects, createPgStore } from './data-pg.js';

test('pg column lists mirror the Sheet headers exactly', () => {
  assert.deepEqual(PG_TABS.Videos.cols, ['video_id','title','channel','url','thumbnail_url','duration_s','views','category','diet_hint','yt_publish_date','date_first_added','date_last_checked','extraction_status']);
  assert.deepEqual(PG_TABS.Recipes.cols, ['recipe_name','video_url','channel','diet','meal_type','time_notes','ingredients','steps','source_note','verified','date_checked']);
  assert.deepEqual(PG_TABS.History.cols, ['date','video_id','title','state','notes']);
  assert.deepEqual(PG_TABS.Picks.cols, ['date','filters','note','suggested_video_ids','chosen_video_id','suggested_titles']);
  assert.deepEqual(PG_TABS.Queue.cols, ['request_id','ts','diet','meal','note','status','answer','reserved']);
  assert.deepEqual(PG_TABS.RawExtracts.cols, ['video_id','title','channel_hint','yt_publish_date','description','transcript','extracted_at','parse_status']);
});

test('buildInsert parameterizes values in column order and pads short rows', () => {
  const q = buildInsert(PG_TABS.History, ['2026-10-27', 'abc123', 'Title', 'saved']);
  assert.equal(q.text, 'INSERT INTO history (date, video_id, title, state, notes) VALUES ($1, $2, $3, $4, $5)');
  assert.deepEqual(q.values, ['2026-10-27', 'abc123', 'Title', 'saved', null]);
});

test('buildInsert never interpolates values into SQL text', () => {
  const evil = `x'); DROP TABLE videos; --`;
  const q = buildInsert(PG_TABS.History, ['d', evil, 't', 's', 'n']);
  assert.ok(!q.text.includes(evil));
  assert.equal(q.values[1], evil);
});

test('rowsToObjects maps to header-keyed objects with null -> empty string', () => {
  const rows = rowsToObjects(PG_TABS.Picks.cols, [
    { date: '2026-10-27', filters: '{"diet":"Veg"}', note: null, suggested_video_ids: 'a,b', chosen_video_id: 'a', suggested_titles: 'A | B' },
  ]);
  assert.deepEqual(rows, [{ date: '2026-10-27', filters: '{"diet":"Veg"}', note: '', suggested_video_ids: 'a,b', chosen_video_id: 'a', suggested_titles: 'A | B' }]);
});

test('createPgStore readTab orders by seq and appendRow uses buildInsert', async () => {
  const calls: any[] = [];
  const fake: any = { query: async (text: string, values?: any[]) => {
    calls.push({ text, values });
    if (String(text).startsWith('SELECT')) return [{ video_id: 'v1', title: 'T' }];
    return [];
  } };
  const store = createPgStore('postgresql://unused', fake);
  const rows = await store.readTab('Videos');
  assert.ok(calls[0].text.includes('ORDER BY seq'));
  assert.equal(rows[0].video_id, 'v1');
  assert.equal(rows[0].extraction_status, '');
  await store.appendRow('Queue', ['r1', '2026-10-27T00:00:00Z', 'Veg', 'Dinner', 'note', 'pending', '', '']);
  assert.equal(calls[1].text, 'INSERT INTO queue (request_id, ts, diet, meal, note, status, answer, reserved) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)');
  assert.equal(calls[1].values[0], 'r1');
});

test('createPgStore rejects unknown tabs', async () => {
  const store = createPgStore('postgresql://unused', { query: async () => [] } as any);
  await assert.rejects(store.appendRow('Nope', ['x']), /unknown tab/);
  assert.deepEqual(await store.readTab('Nope'), []);
});
