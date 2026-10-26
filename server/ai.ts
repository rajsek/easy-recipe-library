/**
 * AI ranking providers - OFF unless AI_PROVIDER plus that provider's key env
 * vars are set. The ranker is ADVISORY ONLY: it re-orders and annotates
 * candidates that already passed the hard rules in pick.ts (verified-only,
 * 30-day no-repeat, diet filter, note word requirements). It can never add,
 * un-exclude, or un-verify a recipe.
 *
 * Privacy: the prompt below is the ONLY place request data leaves this
 * server. It contains candidate recipe names/diets/meals/time notes plus the
 * user's diet/meal filter and note text. History, favourites, identity and
 * Sheet details are never sent.
 *
 * Supported providers (AI_PROVIDER value -> required env):
 *   groq       -> GROQ_API_KEY        (default model openai/gpt-oss-120b; override: GROQ_MODEL)
 *   cloudflare -> CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN
 *                 (model override: CLOUDFLARE_MODEL)
 *   gemini     -> GEMINI_API_KEY      (model override: GEMINI_MODEL)
 */
import type { RankFn, RecipeRow, PickFilter } from './pick.js';

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
  return String(data?.choices?.[0]?.message?.content || '');
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
  return String(data?.result?.response || '');
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
  return String(data?.candidates?.[0]?.content?.parts?.[0]?.text || '');
}

export function buildRankFn(): { rankFn?: RankFn; provider: string } {
  const p = String(process.env.AI_PROVIDER || '').toLowerCase();
  let chat: ((prompt: string) => Promise<string>) | undefined;
  if (p === 'groq' && process.env.GROQ_API_KEY) chat = chatGroq;
  else if (p === 'cloudflare' && process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_API_TOKEN) chat = chatCloudflare;
  else if (p === 'gemini' && process.env.GEMINI_API_KEY) chat = chatGemini;
  if (!chat) return { provider: '' };
  return {
    provider: p,
    rankFn: async (candidates, filter, note) => parseAnswer(await chat!(buildPrompt(candidates, filter, note)))
  };
}
