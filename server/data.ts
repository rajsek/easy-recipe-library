/**
 * Data layer. Two modes:
 *  - demo:   bundled demo-data.json (public YouTube metadata + verified recipe
 *            cards + SYNTHETIC history). Writes stay in memory. No Google
 *            account needed. This is what you get with DATA_MODE=demo.
 *  - sheets: your private Google Sheet via a service account. The Sheet stays
 *            private; you share it once with the service account's email.
 *            See README for setup.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface VideoFilter { q?: string; channel?: string; diet?: string; category?: string; }

type Row = Record<string, any>;

const MODE = (process.env.DATA_MODE || 'demo').toLowerCase();
const SHEET_ID = process.env.SHEET_ID || '';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function rowsFromGrid(values: any[][]): Row[] {
  if (!values || values.length < 2) return [];
  const hdr = values[0].map(String);
  return values.slice(1).map((r) => Object.fromEntries(hdr.map((h, j) => [h, r[j] ?? ''])));
}

// ---------- demo mode ----------
interface DemoData { videos: any[][]; recipes: any[][]; history: Row[]; picks: Row[]; }

function loadDemo(): DemoData {
  const p = path.join(__dirname, 'demo-data.json');
  const d = JSON.parse(readFileSync(p, 'utf8'));
  return { videos: d.videos, recipes: d.recipes, history: d.history || [], picks: d.picks || [] };
}

// ---------- sheets mode ----------
let sheetsClient: any = null;
async function sheets() {
  if (sheetsClient) return sheetsClient;
  const { google } = await import('googleapis');
  let auth: any;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    auth = new google.auth.GoogleAuth({
      keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
  } else {
    throw new Error('sheets mode needs GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS');
  }
  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

async function readTab(name: string): Promise<Row[]> {
  if (MODE === 'demo') {
    const d = loadDemo();
    if (name === 'History') return d.history;
    if (name === 'Picks') return d.picks;
    const grid = name === 'Recipes' ? d.recipes : d.videos;
    return rowsFromGrid(grid);
  }
  const s = await sheets();
  const res = await s.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${name}!A:Z` });
  return rowsFromGrid(res.data.values || []);
}

async function appendRow(name: string, row: any[]): Promise<void> {
  if (MODE === 'demo') return; // demo writes stay in memory in index.ts
  const s = await sheets();
  await s.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${name}!A:Z`,
    valueInputOption: 'RAW',
    requestBody: { values: [row] }
  });
}

// ---------- public API ----------
export async function getVideos(filter: VideoFilter) {
  const rows = await readTab('Videos');
  const q = (filter.q || '').toLowerCase();
  return rows.filter((r) => {
    if (filter.channel && r.channel !== filter.channel) return false;
    // diet_hint is a title-derived hint, not a confirmed classification.
    // 'veg' matches only veg hints; 'non-veg' only explicit egg/meat hints;
    // blank hints are shown only in the unfiltered view.
    if (filter.diet === 'veg' && String(r.diet_hint || '').toLowerCase() !== 'veg') return false;
    if (filter.diet === 'non-veg' && !/egg|non-?veg|chicken|mutton|fish|prawn|meat/i.test(String(r.diet_hint || ''))) return false;
    if (filter.category && (r.category || '') !== filter.category) return false;
    if (q && String(r.title).toLowerCase().indexOf(q) === -1) return false;
    return true;
  }).slice(0, 300).map((r) => ({
    id: r.video_id, title: r.title, channel: r.channel, url: r.url,
    thumb: r.thumbnail_url, views: r.views, category: r.category,
    diet: r.diet_hint, published: r.yt_publish_date || '', status: r.extraction_status
  }));
}

export async function getChannels(): Promise<string[]> {
  const seen: Record<string, true> = {}; const out: string[] = [];
  for (const r of await readTab('Videos')) {
    if (r.channel && !seen[r.channel]) { seen[r.channel] = true; out.push(r.channel); }
  }
  return out;
}

/** Verified + partially-verified recipes. Raw extracts never appear here. */
export async function getRecipes() {
  return (await readTab('Recipes')).filter((r) => {
    const v = String(r.verified).toLowerCase();
    return v === 'yes' || v === 'partial';
  }).map((r) => ({
    name: r.recipe_name, url: r.video_url, channel: r.channel,
    diet: r.diet, meal: r.meal_type, time: r.time_notes,
    ingredients: r.ingredients, steps: String(r.steps).split(' | '),
    source: r.source_note,
    partial: String(r.verified).toLowerCase() === 'partial'
  }));
}

/** Raw recipe rows for the picker (includes the verified flag). */
export async function getRecipeRows(): Promise<Row[]> {
  return readTab('Recipes');
}

export async function getHistory() {
  return (await readTab('History')).map((r) => ({
    date: String(r.date instanceof Date ? r.date.toISOString().slice(0, 10) : r.date),
    id: r.video_id, title: r.title, state: r.state
  }));
}

export async function getHistoryRows(): Promise<Row[]> { return readTab('History'); }
export async function getPickRows(): Promise<Row[]> { return readTab('Picks'); }

const ALLOWED_STATES = new Set(['saved-for-later', 'chosen', 'cooked', 'favourite']);

export async function saveHistory(videoId: string, title: string, state: string) {
  if (!ALLOWED_STATES.has(state)) throw new Error('bad state');
  const date = new Date().toISOString().slice(0, 10);
  if (MODE === 'demo') return { ok: true, date }; // caller keeps it in memory
  await appendRow('History', [date, videoId, title, state, 'app button']);
  return { ok: true, date };
}

/** In-memory picks in demo mode, so the 30-day no-repeat works there too
 *  (resets on server restart, like demo history). */
export const demoPicks: Row[] = [];

export async function recordPick(filter: any, note: string, ids: string[], names: string[]) {
  const date = new Date().toISOString().slice(0, 10);
  if (MODE === 'demo') {
    demoPicks.push({ date, suggested_video_ids: ids.join(',') });
    return;
  }
  await appendRow('Picks', [date, JSON.stringify(filter || {}), note || '', ids.join(','), '', names.join(' | ')]);
}

export const mode = MODE;
