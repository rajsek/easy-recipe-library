/**
 * AI ranking providers - OFF unless AI_PROVIDER plus that provider's key env
 * vars are set. The ranker is ADVISORY ONLY: it re-orders and annotates
 * candidates that already passed the hard rules in pick.ts (verified-only,
 * 30-day no-repeat, diet filter, note word requirements). It can never add,
 * un-exclude, or un-verify a recipe.
 *
 * Privacy: the two prompts below are the ONLY places request data leaves
 * this server. They contain candidate recipe names/diets/meals/time notes,
 * the user's diet/meal filter and note text, and single unmatched note
 * words for classification. History, favourites, identity and Sheet
 * details are never sent.
 *
 * Supported providers (AI_PROVIDER value -> required env):
 *   groq       -> GROQ_API_KEY        (default model openai/gpt-oss-120b; override: GROQ_MODEL)
 *   cloudflare -> CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
 *                 (model override: CLOUDFLARE_MODEL)
 *   gemini     -> GEMINI_API_KEY      (model override: GEMINI_MODEL)
 */
import type { RankFn, RecipeRow, PickFilter, ClassifyFn } from './pick.js';

const TIMEOUT_MS = 15000;

function buildPrompt(candidates: RecipeRow[], filter: PickFilter, note: string): string {
  const list = candidates
    .map((r, i) => `${i}: ${r.recipe_name} (${r.diet}, ${r.meal_type}, ${r.time_notes})`)
    .join('\n');
  return (
    'You are picking recipes for a home cook. Candidate recipes:\n' + list +
    '\n\nFilters: ' + JSON.stringify(filter || {}) +
    '\nRequest note: ' + (note || 'none') +
    '\n\nPick up to 5 candidate numbers that best fit, best first. ' +
    'Reply with JSON only: [{"i":<number>,"reason":"<one short sentence>"}]. No other text.'
  );
}

function parseAnswer(text: string): { order: number[]; reasons: Record<number, string> } {
  const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
  const order: number[] = []; const reasons: Record<number, string> = {};
  for (const item of Array.isArray(parsed) ? parsed : []) {
    if (Number.isInteger(item.i)) { order.push(item.i); reasons[item.i] = String(item.reason || ''); }
  }
  return { order, reasons };
}

async function chatGroq(prompt: string) {
  const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.GROQ_API_KEY },
    body: JSON.stringify({
      model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!resp.ok) throw new Error('groq ' + resp.status);
  const data: any = await resp.json();
  return {
    text: String(data?.choices?.[0]?.message?.content || ''),
    meta: {
      provider: 'groq', model: String(data?.model || process.env.GROQ_MODEL || ''), request_id: String(data?.id || ''),
      prompt_tokens: Number(data?.usage?.prompt_tokens || 0),
      completion_tokens: Number(data?.usage?.completion_tokens || 0),
      total_tokens: Number(data?.usage?.total_tokens || 0),
    },
  };
}

async function chatCloudflare(prompt: string) {
  const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
  const model = process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct';
  const resp = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.CLOUDFLARE_API_TOKEN },
    body: JSON.stringify({ messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!resp.ok) throw new Error('cloudflare ' + resp.status);
  const data: any = await resp.json();
  return { text: String(data?.result?.response || ''), meta: { provider: 'cloudflare', model: model, request_id: '', prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } };
}

async function chatGemini(prompt: string) {
  const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=` + process.env.GEMINI_API_KEY,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    }
  );
  if (!resp.ok) throw new Error('gemini ' + resp.status);
  const data: any = await resp.json();
  const u = data?.usageMetadata || {};
  return {
    text: String(data?.candidates?.[0]?.content?.parts?.[0]?.text || ''),
    meta: { provider: 'gemini', model: model, request_id: '', prompt_tokens: Number(u.promptTokenCount || 0), completion_tokens: Number(u.candidatesTokenCount || 0), total_tokens: Number(u.totalTokenCount || 0) },
  };
}

export interface AiCallMeta { provider: string; model: string; request_id: string; prompt_tokens: number; completion_tokens: number; total_tokens: number; }
export interface AiUsageSink { calls: AiCallMeta[]; }
type ChatFn = (prompt: string) => Promise<{ text: string; meta: AiCallMeta }>;

function resolveChat(): { chat?: ChatFn; provider: string } {
  const p = String(process.env.AI_PROVIDER || '').toLowerCase();
  let chat: ChatFn | undefined;
  if (p === 'groq' && process.env.GROQ_API_KEY) chat = chatGroq;
  else if (p === 'cloudflare' && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) chat = chatCloudflare;
  else if (p === 'gemini' && process.env.GEMINI_API_KEY) chat = chatGemini;
  return { chat, provider: chat ? p : '' };
}

export function buildRankFn(rankSink?: AiUsageSink): { rankFn?: RankFn; provider: string } {
  const { chat, provider } = resolveChat();
  if (!chat) return { provider: '' };
  return {
    provider,
    rankFn: async (candidates, filter, note) => {
      const r = await chat(buildPrompt(candidates, filter, note));
      rankSink?.calls.push(r.meta);
      return parseAnswer(r.text);
    }
  };
}

// Classifies unmatched note words so the picker can tell a missing
// ingredient (hard requirement) from a mood (soft preference). Conservative
// by contract: anything not clearly a mood comes back as food/unknown.
export function buildClassifyFn(sink?: AiUsageSink): ClassifyFn | undefined {
  const { chat } = resolveChat();
  if (!chat) return undefined;
  return async (words: string[]) => {
    const prompt =
      'Classify each word as "food" or "mood".\n' +
      'food = an ingredient, dish, cuisine, allergen or drink (pasta, tofu, peanut, milk, bread, Italian).\n' +
      'mood = a cooking or eating preference (light, quick, spicy, comforting, kid-friendly).\n' +
      'If unsure, answer food.\n' +
      'Obvious misspellings of an ingredient are still food ("panner", "panir" = paneer).\n' +
      'Words: ' + words.join(', ') + '\n' +
      'Reply with ONLY a JSON object mapping each word to "food" or "mood".';
    const r = await chat(prompt);
    sink?.calls.push(r.meta);
    const out = r.text;
    const m2 = out.match(/\{[\s\S]*\}/);
    if (!m2) return Object.fromEntries(words.map((w) => [w, 'unknown' as const]));
    try {
      const parsed = JSON.parse(m2[0]);
      return Object.fromEntries(words.map((w) => [w, parsed[w] === 'mood' ? 'mood' as const : 'food' as const]));
    } catch {
      return Object.fromEntries(words.map((w) => [w, 'unknown' as const]));
    }
  };
}

// Free-question answering for the app's "Instant AI answer" mode. The hard
// constraints are enforced OUTSIDE the model: index.ts passes only
// filterCandidateRecipes() output (verified-only, diet/meal rules identical
// to picks), and every recipe the answer names must be wrapped in
// [[exact name]] markers that are validated server-side against that list.
// An answer referencing anything outside the candidate list is retried once
// with a correction, then rejected with an honest error - never shown.
// Provider failures (including free-quota exhaustion) surface as honest
// errors; there is no paid fallback anywhere.

export type ChatOnly = (prompt: string) => Promise<{ text: string; meta: AiCallMeta }>;

// Recipe references the answer makes: [[explicit markers]] plus **bolded**
// spans, which is how the models habitually write dish names. Both are
// validated against the candidate aliases - a valid marked recipe must never
// shield an invented unmarked one.
export interface AskAnswer { text: string; recipes: RecipeRow[]; }

// Structured contract: the model cites candidates by NUMBER and the server
// resolves those numbers to canonical library rows. Prose can never become a
// recipe reference on its own - the cards the app shows come only from
// validated ids, so an invented name has no way to render as a library recipe.
export interface VideoRef { video_id: string; title: string; channel: string; url: string; status: string; }

export async function askWithValidation(
  chat: ChatOnly,
  recipes: RecipeRow[],
  question: string,
  filter: PickFilter,
  sink?: AiUsageSink,
  videos?: VideoRef[]
): Promise<AskAnswer & { videos: VideoRef[] }> {
  const vids = videos || [];
  const vlist = vids.length
    ? '\n\nLibrary videos (titles only - ingredients and steps NOT extracted yet):\n' +
      vids.map((v, i) => 'V' + (i + 1) + '. ' + v.title + ' (' + v.channel + ')').join('\n')
    : '';
  const list = recipes
    .slice(0, 60)
    .map((r, i) => (i + 1) + '. ' + r.recipe_name + ' (' + (r.diet || '') + ', ' + (r.meal_type || '') + '): ' + String(r.ingredients || '').slice(0, 140))
    .join('\n');
  const prompt =
    "You are the assistant inside a personal recipe library app. Answer the cook's question using ONLY the verified recipes below. " +
    'Reply with strict JSON only, no other text: {"text": "your answer", "ids": [1, 2], "vids": [1]}. ' +
    '"ids" lists the numbers of the recipes your answer uses (empty array if none); mention a recipe in "text" only when its number is in "ids". ' +
    'When library videos are listed, "vids" lists their numbers for any video you suggest; always say a video\'s ingredients and steps are not extracted yet - never invent them, and offer up to 5 suggestions total across recipes and videos. ' +
    'If the question is not about cooking or these recipes, say you can only help with this recipe library. ' +
    'Never give medical, nutrition or allergy advice; tell the cook to check ingredients themselves. ' +
    'The cook may make typos: read an obvious spelling variant as the ingredient it means ("panner" = "paneer") and say so in "text" ("taking panner as paneer"). ' +
    'If a typo could mean two different ingredients, ask which one instead of guessing. ' +
    'Hard constraints are never relaxed: only the recipes listed below may be cited, whatever the question asks for. ' +
    'The list below may be a FILTERED subset of the library: never claim the library as a whole lacks a dish or ingredient - say "none of these filtered recipes" and suggest loosening the filters instead. ' +
    'A recipe marked "Veg (needs ...)" is only conditionally vegetarian: when you cite one, state its condition (for example, that the dip needs eggless mayo) - never present it as plain veg. ' +
    'Keep "text" under 120 words.\n\nVerified recipes:\n' + list +
    vlist +
    '\n\nFilters: ' + JSON.stringify(filter || {}) +
    '\nQuestion: ' + question + '\nJSON:';
  const parse = (s: string): { text: string; ids: number[]; vids: number[] } | undefined => {
    const m = s.match(/\{[\s\S]*\}/);
    if (!m) return undefined;
    try {
      const j = JSON.parse(m[0]);
      if (typeof j?.text !== 'string' || !Array.isArray(j?.ids)) return undefined;
      return { text: j.text, ids: j.ids.filter((x: unknown) => Number.isInteger(x)), vids: Array.isArray(j?.vids) ? j.vids.filter((x: unknown) => Number.isInteger(x)) : [] };
    } catch { return undefined; }
  };
  const badIds = (ids: number[]) => ids.filter((i) => i < 1 || i > recipes.length);
  const badVids = (vs: number[]) => vs.filter((i) => i < 1 || i > vids.length);
  const r1 = await chat(prompt);
  sink?.calls.push(r1.meta);
  let parsed = parse(r1.text);
  let bad = parsed ? [...badIds(parsed.ids), ...badVids(parsed.vids)] : [];
  if (!parsed || bad.length > 0) {
    const r2 = await chat(
      prompt +
      '\n\nYour previous reply was invalid. Reply with strict JSON only: {"text": string, "ids": number[]} using list numbers 1-' + recipes.length + ' only.'
    );
    sink?.calls.push(r2.meta);
    parsed = parse(r2.text);
    bad = parsed ? [...badIds(parsed.ids), ...badVids(parsed.vids)] : [];
    if (!parsed || bad.length > 0) {
      console.warn('ask-ai rejected answer: invalid structured reference count:', parsed ? bad.length : -1);
      throw new Error('AI answer failed reference validation');
    }
  }
  const seen = new Set<number>();
  const cited = parsed.ids.filter((i) => !seen.has(i) && seen.add(i)).map((i) => recipes[i - 1]);
  // Defensive: strip any residual markdown wrappers from the prose.
  const text = parsed.text.replace(/\[\[([^\]]+)\]\]/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
  const citedVids = parsed.vids.filter((i, n, arr) => arr.indexOf(i) === n).map((i) => vids[i - 1]);
  return { text, recipes: cited, videos: citedVids };
}

export function buildAskFn(sink?: AiUsageSink): ((recipes: RecipeRow[], question: string, filter: PickFilter, videos?: VideoRef[]) => Promise<AskAnswer & { videos: VideoRef[] }>) | undefined {
  const { chat } = resolveChat();
  if (!chat) return undefined;
  return (recipes, question, filter, videos) => askWithValidation(chat, recipes, question, filter, sink, videos);
}
