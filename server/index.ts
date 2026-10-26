/**
 * Easy Recipe Library - API server.
 * Serves the built web app (web/dist) and a small JSON API.
 *
 * AI ranking: OFF unless BOTH AI_PROVIDER=gemini and GEMINI_API_KEY are set in
 * .env. Until then picks are deterministic and clearly labeled, and no request
 * note text leaves this server. The Gemini call below is the single place
 * where request data can reach a provider, and it sends only the candidate
 * list (public recipe data) plus this request's filters/note.
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  getVideos, getChannels, getRecipes, getRecipeRows, getHistory,
  getHistoryRows, getPickRows, saveHistory, recordPick, mode
} from './data.js';
import { pickForMe, excludedIds, type RankFn } from './pick.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Demo mode keeps history writes in memory only - never touches a real Sheet.
const demoMemory: { history: any[] } = { history: [] };

// --- access control (see README "Security") ---
// Default: bind localhost only. Any non-local interface requires APP_TOKEN.
const HOST = process.env.HOST || '127.0.0.1';
const APP_TOKEN = process.env.APP_TOKEN || '';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '::ffff:127.0.0.1']);
if (!LOCAL_HOSTS.has(HOST) && !APP_TOKEN) {
  console.error('Refusing to start: HOST=' + HOST + ' is not local and APP_TOKEN is not set. Set APP_TOKEN in .env (see README "Security").');
  process.exit(1);
}
app.use('/api', (req, res, next) => {
  if (!APP_TOKEN) return next();
  if (req.get('authorization') === 'Bearer ' + APP_TOKEN) return next();
  res.status(401).json({ error: 'unauthorized - send Authorization: Bearer <APP_TOKEN>' });
});

// Basic per-IP rate limit on writes: 60 mutations per 5 minutes.
const writeHits = new Map<string, number[]>();
app.use('/api', (req, res, next) => {
  if (req.method === 'GET') return next();
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const arr = (writeHits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (arr.length >= 60) return res.status(429).json({ error: 'rate limit exceeded' });
  arr.push(now); writeHits.set(ip, arr);
  next();
});

app.get('/api/state', (_req, res) => res.json({ mode, ai: !!rankFn }));

app.get('/api/channels', async (_req, res) => res.json(await getChannels()));

app.get('/api/videos', async (req, res) => {
  res.json(await getVideos({
    q: String(req.query.q || ''), channel: String(req.query.channel || ''),
    diet: String(req.query.diet || ''), category: String(req.query.category || '')
  }));
});

app.get('/api/recipes', async (_req, res) => res.json(await getRecipes()));

app.get('/api/history', async (_req, res) => {
  const h = await getHistory();
  res.json([...h, ...demoMemory.history]);
});

app.post('/api/history', async (req, res) => {
  try {
    const { video_id, title, state } = req.body || {};
    if (!/^[\w-]{1,20}$/.test(String(video_id || ''))) throw new Error('bad video_id');
    if (String(title || '').length > 200) throw new Error('title too long');
    if (mode === 'demo') {
      if (!['saved-for-later', 'chosen', 'cooked', 'favourite'].includes(state)) throw new Error('bad state');
      const date = new Date().toISOString().slice(0, 10);
      demoMemory.history.push({ date, id: video_id, title, state });
      res.json({ ok: true, date });
      return;
    }
    res.json(await saveHistory(String(video_id || ''), String(title || ''), String(state || '')));
  } catch (e: any) {
    res.status(400).json({ error: e.message || 'save failed' });
  }
});

// Gemini ranking - only when the owner opted in via .env (see README privacy note).
const rankFn: RankFn | undefined =
  process.env.AI_PROVIDER === 'gemini' && process.env.GEMINI_API_KEY
    ? async (candidates, filter, note) => {
        const list = candidates
          .map((r, i) => `${i}: ${r.recipe_name} (${r.diet}, ${r.meal_type}, ${r.time_notes})`)
          .join('\n');
        const prompt =
          'You are picking recipes for a home cook. Candidate recipes:\n' + list +
          '\n\nFilters: ' + JSON.stringify(filter || {}) +
          '\nRequest note: ' + (note || 'none') +
          '\n\nPick up to 5 candidate numbers that best fit, best first. ' +
          'Reply with JSON only: [{"i":<number>,"reason":"<one short sentence>"}]. No other text.';
        const resp = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' +
            process.env.GEMINI_API_KEY,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
          }
        );
        if (!resp.ok) throw new Error('gemini ' + resp.status);
        const data: any = await resp.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        const order: number[] = []; const reasons: Record<number, string> = {};
        for (const item of Array.isArray(parsed) ? parsed : []) {
          if (Number.isInteger(item.i)) { order.push(item.i); reasons[item.i] = String(item.reason || ''); }
        }
        return { order, reasons };
      }
    : undefined;

app.post('/api/pick', async (req, res) => {
  const diet = String(req.body?.diet || '');
  const meal = String(req.body?.meal || '');
  if (diet && !['Veg', 'Non-veg', 'Egg', 'Contains egg'].includes(diet)) return res.status(400).json({ error: 'bad diet' });
  if (meal.length > 40) return res.status(400).json({ error: 'bad meal' });
  const filter = { diet, meal };
  const note = String(req.body?.note || '').slice(0, 200);
  const [recipes, history, picks] = await Promise.all([getRecipeRows(), getHistoryRows(), getPickRows()]);
  const ex = excludedIds(
    mode === 'demo' ? [...history, ...demoMemory.history.map((h) => ({ ...h, video_id: h.id }))] : history,
    picks
  );
  const result = await pickForMe(filter, note, recipes as any, ex, rankFn);
  await recordPick(filter, note, result.ids, result.picks.map((p) => p.name));
  res.json(result);
});

// Built frontend (npm run build). In dev, use the Vite server instead.
const dist = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(dist));
app.get('*', (_req, res, next) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => { if (err) next(); });
});

const port = Number(process.env.PORT || 3000);
app.listen(port, HOST, () => {
  console.log(`Easy Recipe Library (${mode} mode, AI ${rankFn ? 'ON' : 'off'}, auth ${APP_TOKEN ? 'ON' : 'off'}) -> http://${HOST}:${port}`);
});
