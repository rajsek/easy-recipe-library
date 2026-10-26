/**
 * Easy Recipe Library - API server.
 * Serves the built web app (web/dist) and a small JSON API.
 *
 * AI ranking: OFF unless AI_PROVIDER plus that provider's key env vars are
 * set (.env locally). Until then picks are deterministic and clearly labeled,
 * and no request note text leaves this server. The provider call in ai.ts is
 * the single place request data can reach a provider, and it sends only the
 * candidate list (public recipe data) plus this request's filters/note.
 */
import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  getVideos, getChannels, getRecipes, getRecipeRows, getHistory,
  getHistoryRows, getPickRows, saveHistory, recordPick, demoPicks, mode,
  addQueueRequest, getQueueRequest
} from './data.js';
import { pickForMe, excludedIds, excludedForAsk, filterCandidateRecipes, constrainAskCandidates, parseNote, noteVocab, normalizeNoteWords } from './pick.js';
import { semanticRank, semanticStatus, constraintSignature, SemanticCache, SEMANTIC_VERSION, loadSemantic } from './semantic.js';
import { retrieveVideos, ragStatus } from './rag.js';
import { getSession, putSession, clearSession, isMoreIntent, validSessionId } from './session.js';
import { createHash } from 'node:crypto';
import { CommTrace, MemoryTraceStore } from './comm-trace.js';
import { randomUUID } from 'node:crypto';
import { buildRankFn, buildClassifyFn, buildAskFn } from './ai.js';

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

app.get('/api/state', (_req, res) => res.json({ mode, ai: !!aiProvider, aiProvider, semantic: semanticStatus(), rag: ragStatus() }));

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

// AI ranking - only when the owner opted in via env (see README privacy note).
// Builders are called per request with a request-scoped usage sink so the
// trace records provider-reported tokens for exactly this request's calls.
const { provider: aiProvider } = buildRankFn();
const askCache = new SemanticCache();
function libraryVersion(recipes: any[]): string {
  const h = createHash('sha256');
  for (const r of recipes) h.update(String(r.recipe_name) + '|' + String(r.diet) + '|' + String(r.verified) + ';');
  return h.digest('hex').slice(0, 12);
}

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
    mode === 'demo' ? [...picks, ...demoPicks] : picks
  );
  const sink = { calls: [] as any[] };
  const { rankFn } = buildRankFn(sink);
  const classifyFn = buildClassifyFn(sink);
  // Meaning-aware slim: when the pool is large, embeddings pick the 12 most
  // relevant candidates BEFORE any AI call - smaller prompts, fewer tokens.
  // Hard constraints already ran; null (model unavailable) keeps the full pool.
  const slimFn = async (cs: any[]) => semanticRank((note || '') + ' ' + diet + ' ' + meal, cs, 12);
  const result = await pickForMe(filter, note, recipes as any, ex, rankFn, classifyFn, slimFn);
  await recordPick(filter, note, result.ids, result.picks.map((p) => p.name));
  const usage = sink.calls.reduce((a, c) => ({ prompt: a.prompt + c.prompt_tokens, completion: a.completion + c.completion_tokens, total: a.total + c.total_tokens }), { prompt: 0, completion: 0, total: 0 });
  res.json({ ...result, usage: { ...usage, calls: sink.calls.length, provider: aiProvider || '' }, semantic: semanticStatus().available ? SEMANTIC_VERSION : 'off' });
});

// Request queue ("ask in the app"): writes a row to the private Queue tab;
// the owner's assistant answers there. Sheets mode only - honest 503 in demo.
app.post('/api/ask', async (req, res) => {
  if (mode === 'demo') return res.status(503).json({ error: 'Ask-in-app needs the Sheet connection, which demo mode does not have. Use the WhatsApp option meanwhile.' });
  const diet = String(req.body?.diet || '');
  const meal = String(req.body?.meal || '');
  if (diet && !['Veg', 'Non-veg', 'Egg', 'Contains egg'].includes(diet)) return res.status(400).json({ error: 'bad diet' });
  if (meal.length > 40) return res.status(400).json({ error: 'bad meal' });
  const note = String(req.body?.note || '').slice(0, 200);
  try {
    const id = await addQueueRequest({ diet, meal, note });
    res.json({ request_id: id });
  } catch (e: any) {
    res.status(500).json({ error: e.message || 'could not queue the request' });
  }
});
// Instant AI answer ("free AI in app" mode). Advisory-only: constrained to
// verified recipes, refuses medical/nutrition/allergy advice and off-topic
// questions (prompt-enforced). Honest 503 when no provider is configured.
const commTrace = CommTrace.fromEnv(new MemoryTraceStore());

app.get('/api/traces', async (_req, res) => {
  res.json({ enabled: commTrace.enabled, persistent: false, note: 'Demo store resets on restart; the encrypted Sheet-backed store lands with the Google connection.', traces: await commTrace.readAll() });
});
app.delete('/api/traces', async (_req, res) => {
  await (commTrace as any).store?.clear?.();
  res.json({ cleared: true });
});

app.post('/api/ask-ai', async (req, res) => {
  const sink = { calls: [] as any[] };
  const askFn = buildAskFn(sink);
  const classifyFn = buildClassifyFn(sink);
  if (!askFn) return res.status(503).json({ error: 'AI answers are not set up on this deployment.' });
  const traceId = randomUUID().slice(0, 8);
  const traceBase = { request_id: traceId, ts: new Date().toISOString(), mode: 'ai' as const, request_text: String(req.body?.question || '').slice(0, 500), model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b', prompt_version: 'ask-v2-json' };
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'no question given' });
  if (question.length > 500) return res.status(400).json({ error: 'question too long (500 chars max)' });
  let diet = String(req.body?.diet || '');
  let meal = String(req.body?.meal || '');
  if (diet && !['Veg', 'Non-veg', 'Egg', 'Contains egg'].includes(diet)) return res.status(400).json({ error: 'bad diet' });
  // App-managed session: a follow-up ("another option") continues the stored
  // request instead of starting blank. Provider stays stateless; the compact
  // context is ours.
  const sessionId = validSessionId(req.body?.session_id) ? String(req.body.session_id) : '';
  const more = isMoreIntent(question);
  const prior = sessionId ? getSession(sessionId) : null;
  if (more && prior) {
    if (!diet) diet = prior.diet;
    if (!meal) meal = prior.meal;
  }
  const sessionEcho = { session_id: sessionId, continued: !!(more && prior), diet, meal };
  // Warm the local embedding model in the background (bounded, non-blocking)
  // so the slim + answer cache engage on later requests to this instance.
  loadSemantic().catch(() => {});
  try {
    // Same hard constraints as picks: verified/diet/meal via the shared
    // filter, then the ask route's own rules - hard "no X" exclusions, the
    // 30-day no-repeat (unless the question names the dish), and explicit
    // food words as hard requirements with an honest zero, never invention.
    const [recipes, history, picks] = await Promise.all([getRecipeRows(), getHistoryRows(), getPickRows()]);
    const ex = excludedForAsk(
      mode === 'demo' ? [...history, ...demoMemory.history.map((h) => ({ ...h, video_id: h.id }))] : history,
      mode === 'demo' ? [...picks, ...demoPicks] : picks
    );
    // A continued request also hides what it was just shown.
    if (more && prior) for (const id of prior.lastVideoIds) ex.videoOnly[id] = true;
    const base = filterCandidateRecipes(recipes as any, { diet, meal });
    const keywords = parseNote(question).keywords;
    // Constraint signature for the semantic cache: normalized note words,
    // current no-repeat state, library and model versions, intent. A wording
    // look-alike with different constraints NEVER reuses an answer. Computed
    // BEFORE any model call: a cache hit costs zero AI calls, zero tokens.
    const vocab = noteVocab(recipes as any);
    const kwN = normalizeNoteWords(keywords, vocab);
    const exN = normalizeNoteWords(parseNote(question).exclusions, vocab);
    const excludedHash = createHash('sha256').update(JSON.stringify([Object.keys(ex.videoOnly).sort(), Object.keys(ex.titles).sort()])).digest('hex').slice(0, 12);
    const intent = more ? 'more' : 'answer';
    const sig = constraintSignature({ diet, meal, exclusions: exN.words, foodWords: kwN.words, excludedHash, libraryVersion: libraryVersion(recipes as any), intent });
    const cached = await askCache.get(question, sig, intent);
    if (cached) {
      await commTrace.record({ ...traceBase, outbound_payload: 'ask-ai: semantic cache hit - no model call', reply_text: JSON.stringify(cached).slice(0, 400), handling: 'cache hit; 0 AI calls; 0 tokens', status: 'ok', semantic: 'hit', ai_calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
      return res.json({ ...(cached as object), request_id: traceId, cached: true, session: sessionEcho });
    }
    let cls: Record<string, string> = {};
    if (classifyFn && keywords.length > 0) {
      try { cls = await classifyFn(keywords); } catch { cls = {}; }
    }
    const { candidates, zeroReason, interpreted } = constrainAskCandidates(base, question, ex, cls, vocab, filterCandidateRecipes(recipes as any, {}));
    if (zeroReason) {
      await commTrace.record({ ...traceBase, outbound_payload: 'ask-ai: ' + candidates.length + ' candidates after constraints; zeroReason: ' + zeroReason, reply_text: 'honest zero answer', handling: 'no candidates; no model call', status: 'ok' });
      return res.json({ answer: zeroReason, request_id: traceId, interpreted, session: sessionEcho });
    }
    // Meaning-aware slim: large pools shrink to the 25 most relevant
    // candidates before the model sees anything - smaller prompt, fewer
    // tokens. Hard constraints already ran; a slim failure keeps the pool.
    let forModel = candidates;
    if (candidates.length > 25) {
      const slim = await semanticRank(question, candidates, 25);
      if (slim) forModel = slim;
    }
    // Full-corpus retrieval: top video-index matches for this question,
    // excluding videos already represented by an extracted card. The model
    // may suggest them, clearly labelled "details not extracted yet".
    const cardIds: Record<string, true> = {};
    for (const c of forModel) { const m = String(c.video_url || '').match(/v=([\w-]{11})/); if (m) cardIds[m[1]] = true; }
    let videoRefs: any[] = [];
    try {
      const found = await retrieveVideos(question + ' ' + diet + ' ' + meal, 10, cardIds);
      if (found) videoRefs = found.filter((v) => v.score >= 0.45).slice(0, 8).map((v) => ({ video_id: v.video_id, title: v.title, channel: v.channel, url: 'https://www.youtube.com/watch?v=' + v.video_id, status: 'video found - details not extracted yet' }));
    } catch { videoRefs = []; }
    const { text, recipes: cited, videos: citedVideos } = await askFn(forModel, question, { diet, meal }, videoRefs);
    const usage = sink.calls.reduce((a, c) => ({ prompt: a.prompt + c.prompt_tokens, completion: a.completion + c.completion_tokens, total: a.total + c.total_tokens }), { prompt: 0, completion: 0, total: 0 });
    const body = {
      answer: text,
      recipes: cited.map((r: any) => ({ name: r.recipe_name, url: r.video_url, time: r.time_notes || '', diet: r.diet || '', meal: r.meal_type || '', reason: '' })),
      videos: (citedVideos || []).map((v: any) => ({ title: v.title, url: v.url, channel: v.channel, status: v.status })),
    };
    await askCache.put(question, sig, body);
    if (sessionId) putSession(sessionId, { diet, meal, exclusions: exN.words, lastVideoIds: cited.map((r: any) => String(r.video_url || '')).map((u: string) => (u.match(/v=([\w-]{11})/) || [])[1] || '').filter(Boolean) });
    await commTrace.record({
      ...traceBase, outbound_payload: 'ask-ai: ' + forModel.length + ' verified candidates + question', reply_text: text,
      handling: 'filters: diet=' + (diet || 'any') + ' meal=' + (meal || 'any') + '; ' + cited.length + ' cited cards; status 200', status: 'ok',
      semantic: 'miss', ai_calls: sink.calls.length,
      prompt_tokens: usage.prompt, completion_tokens: usage.completion, total_tokens: usage.total,
      provider_request_ids: sink.calls.map((c) => c.request_id).filter(Boolean),
    });
    res.json({ ...body, request_id: traceId, session: sessionEcho, usage: { ...usage, calls: sink.calls.length, provider: aiProvider || '' } });
  } catch {
    await commTrace.record({ ...traceBase, outbound_payload: 'ask-ai', reply_text: '', handling: 'model or validation failure', status: 'error', error: 'AI answer failed validation or provider call' });
    res.status(502).json({ error: 'The AI answer failed this time - please try again.', request_id: traceId });
  }
});

app.post('/api/session/reset', (req, res) => {
  const id = validSessionId(req.body?.session_id) ? String(req.body.session_id) : '';
  if (id) clearSession(id);
  // Honest scope: demo sessions live in this instance's memory only.
  res.json({ cleared: !!id, persistent: false });
});

app.get('/api/ask/:id', async (req, res) => {
  if (mode === 'demo') return res.status(503).json({ error: 'Ask-in-app needs the Sheet connection, which demo mode does not have.' });
  const r = await getQueueRequest(String(req.params.id || ''));
  if (!r) return res.status(404).json({ error: 'unknown request' });
  res.json(r);
});

// Built frontend (npm run build). In dev, use the Vite server instead.
const dist = path.join(__dirname, '..', 'web', 'dist');
app.use(express.static(dist));
app.get('*', (_req, res, next) => {
  res.sendFile(path.join(dist, 'index.html'), (err) => { if (err) next(); });
});

// Exported for serverless hosts (e.g. Vercel zero-config Express, which
// imports this module instead of running it). Local runs still call listen().
export default app;

const isDirectRun = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isDirectRun) {
  const port = Number(process.env.PORT || 3000);
  app.listen(port, HOST, () => {
    console.log(`Easy Recipe Library (${mode} mode, AI ${aiProvider ? 'ON:' + aiProvider : 'off'}, auth ${APP_TOKEN ? 'ON' : 'off'}) -> http://${HOST}:${port}`);
  });
}
