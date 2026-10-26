# Architecture

This file describes how the app is put together. It is updated in the same
commit as any architecture change, keeping section headings and diagram node
IDs stable so `git diff` shows exactly what each change touched.

## Current state (as of 2026-10-26 ~20:30 IST; production = deployment of 64088bb)

Live on Vercel (Hobby, free tier), demo-snapshot mode. PRODUCTION currently serves
deployment of commit 64088bb: 62 cards (61 verified + 1 partial) + 4468-video index,
AND note semantics, staged zero-reasons, and the multi-chip typeahead UI (64088bb is
the useRef hotfix that restored the page after the blank-screen incident; the npm
build now runs tsc --noEmit before vite). The repo main is newer (chips-only Ask
button fix) and AWAITS its build; "State" below says Live only for what production
actually serves. Saves/history are per-instance memory and reset on restart.

## Request flow (diagram)

```mermaid
flowchart LR
    user([Cook]) --> ui[web-ui]
    ui -->|"/api/pick"| guard[guardrails]
    ui -->|"/api/ask-ai"| session[session-store]
    session --> cache[semantic-cache]
    cache -->|miss| guard
    cache -->|hit| ui
    guard -->|filtered candidates| retrieval[rag-retrieval]
    minilm[minilm-matcher] -->|question vector| retrieval
    embedfile[(embeddings-index)] --> retrieval
    retrieval -->|ranked shortlist| groq[groq-answerer]
    minilm -->|slim + cache match| cache
    groq -->|validated answer| ui
    snapshot[(snapshot-data)] --> guard
    snapshot --> retrieval
    subgraph future["Planned / disabled"]
        sheet[(live-sheet)]
        doctab[doc-bridge]
        passkey[passkey-login]
        tracestore[(encrypted-trace-store)]
    end
```

## Components

| ID | Component | Role | State |
| --- | --- | --- | --- |
| web-ui | React app (Vite build) | Filters, picks, ask, history, comms | Live |
| guardrails | Deterministic checks (server/pick.ts) | Verified-only, strict diet, exclusions, food words, 30-day no-repeat. Multiple food words combine as AND; question words are never interpreted as ingredients; a zero answer names the real cause with counts (no-repeat vs diet/meal vs own exclusion vs library gap). Always run BEFORE any model; no model can widen the pool | Live in production (64088bb): AND semantics, question-word guard, staged zero-reasons |
| session-store | In-memory ask sessions (server/session.ts) | 30-min TTL; follow-ups like "another option" reuse stored diet/meal and hide what was just shown; reset via "New conversation" | Live (resets on restart) |
| semantic-cache | Answer reuse (server/semantic.ts) | A repeat question with the SAME constraints + library + intent is answered with 0 AI calls; "another option" and any constraint change bypass it | Live |
| rag-retrieval | Full-corpus retrieval (server/rag.ts) | Top video-index matches join the shortlist, labelled "video found - details not extracted yet"; details are never invented | Live (verified 2026-10-26 19:47 IST: production /api/state rag.ready=true with 4468 titles; a paneer ask returned 3 checked cards + 2 labelled video suggestions) |
| minilm-matcher | Local matching model (Xenova/all-MiniLM-L6-v2, pinned revision, Apache-2.0) | Turns question + titles into number patterns for meaning matching and the answer cache. Runs inside the app server; question/recipe text never leaves for matching. Pluggable: `SEMANTIC=off` disables it and the app falls back to plain word rules, honestly labelled | Live, optional |
| groq-answerer | Groq chat API (openai/gpt-oss-120b) | Writes the answer from the shortlist only; cited recipes are validated server-side, one corrective retry then honest reject | Live |
| snapshot-data | server/demo-data.json | Dated public video-derived copy of the library; private history never published | Live in production (64088bb): 62 cards (61 verified + 1 partial, 2026-10-26) |
| ingredient-typeahead | server/pick.ts typeaheadVocab + /api/ingredients + chips UI | Canonical ingredient words from the checked library (curated 141-word allowlist); tap/keyboard multi-select composed into ask + pick notes; zero AI per keystroke | Live in production (64088bb): vocab endpoint + chips UI + allowlist + multi-select |
| embeddings-index | server/demo-embeddings.json | Precomputed MiniLM vectors (int8) for all 4468 video titles; regenerated with each snapshot refresh | Live (bundling fixed by literal-__dirname tracing in 69315b9; verified with rag-retrieval) |
| live-sheet | Private Google Sheet | Source of truth for recipes, history, traces | Planned (needs account connection) |
| doc-bridge | Shared Google Doc | Chat bridge to the assistant | Disabled (notification unproven) |
| passkey-login | Fingerprint login | Optional sign-in addition | Not built |
| encrypted-trace-store | Sheet-backed trace | Persistent encrypted communication log | Planned (needs account connection); in-memory encrypted trace live meanwhile |

## Models and providers

- **Groq** (cloud): writes and explains answers. Sees only the shortlisted
  candidates plus the question. Measured 712-3926 tokens per ask
  (provider-reported); repeated identical asks use 0 (cache).
- **MiniLM** (local, in-app): meaning matching + cache only. Writes nothing.
  One 22 MB download per server instance from huggingface.co; bounded load
  (20 s timeout) with honest degradation; never blocks a request.

## Data storage

- Recipe cards + video index: snapshot files in this repo (public, video-derived only).
- Sessions, picks, history: per-instance memory in demo mode (reset honestly).
- Communication trace: encrypted (AES-256-GCM, key in server env), in-memory
  per instance in demo mode; token counts are provider-reported.

## Token minimization

1. Guardrails shrink the pool deterministically (free).
2. MiniLM ranks/slims what remains, so Groq sees ~25 candidates, not hundreds.
3. The semantic cache answers exact repeats with no Groq call.
4. Sessions send compact context (diet/meal/last ideas), not chat history.

## Trust boundaries

- The web UI talks only to this app's own API (token-gated when APP_TOKEN is set).
- Only Groq receives app content, and only the minimal shortlist per request.
- Matching (MiniLM) and retrieval are fully local to the app server.
- Private identifiers (Sheet ID, history, tokens) are never committed here.

## Deployment and fallbacks

- Vercel Hobby (free). The serverless bundle must explicitly include the JSON
  snapshots: vercel.json `functions["server.ts"].includeFiles` lists
  `web/dist/**`, `server/demo-data.json`, `server/demo-embeddings.json`
  (without this the embeddings index silently fails to load and retrieval
  degrades honestly). Builds trigger on push to main; a Deploy Hook
  (rebuild-main) exists as a manual fallback when push events stall. If
  MiniLM fails to load, the app says so and uses plain
  word rules. If Groq is down, asks return an honest error; picks still work
  unranked. If the embeddings index is missing, video suggestions simply stop
  (recipes still work).

## Change history

Newest first. SHAs are real commits on main.

| Date (IST) | Commit(s) | What changed |
| --- | --- | --- |
| 2026-10-26 20:23 | 3208a7f | web-ui: selected ingredient chips alone enable the Ask button (chips-only ask); committed, awaiting deploy |
| 2026-10-26 20:19 | e06f312 | build: npm run build runs tsc --noEmit -p web before vite so a missing import fails the build instead of shipping a blank page; committed, awaiting deploy |
| 2026-10-26 20:19 | 64088bb | web-ui hotfix: import useRef (blank-screen ReferenceError); deployed and live-verified (renders, 62 cards, AND pick, zero-reason, console clean, mobile) |
| 2026-10-26 19:57 | 7c091b5 | snapshot-data: 62 cards (61 verified + 1 partial), +2 paneer cards, 7 paneer video extraction statuses |
| 2026-10-26 19:56 | f81abc3, 4fb5f27, e076c65, 1707524 | guardrails: food words combine as AND; question words never interpreted as ingredients ("what" is not "wheat"); zero answers name the real cause with counts; honest-zero asks also offer labelled video alternatives |
| 2026-10-26 19:47 | 69315b9, 357baa5 | rag-retrieval + embeddings-index live-verified (production deployment of 112bc52; rag.ready=true, 4468 titles) |
| 2026-10-26 19:38 | 112bc52, 7f47c8c, d4c9f1f, 89f02fa, c217c54, bfb12c3, f7b2df8, df4eadf | ingredient-typeahead added: vocab endpoint, curated allowlist, multi-select chips; zero AI per keystroke |
| 2026-10-26 18:41 | dd59c44 | vercel.json: JSON snapshots explicitly included in the serverless bundle |
| 2026-10-26 18:34 | 73f1710 | architecture.md added (this file) |
| 2026-10-26 18:33 | 7f67f04 | embeddings-index added (4468 video-title vectors, int8) |
| 2026-10-26 18:27 | 2b6a23d, fb110ca, 272afa6, ea0610c | rag-retrieval added: video matches join ask shortlist with honest labels |
| 2026-10-26 18:22 | 213b21a, 8e7c134, 82d313d, fe86bdd, 073d61f | Guardrails fail closed without the classifier; absence answers qualified ("none under these filters", never "none in the library") |
| 2026-10-26 18:17 | 562f1b9, 4430600, af6ec97, 9dfdeb7, 4d14c74 | Diet words ("veg") never treated as ingredients; background model warm-up; meaning-layer status in UI |
| 2026-10-26 18:14 | 42d97f5 | Model load never blocks a request |
| 2026-10-26 18:13 | d9cdda5, c8134a7, 22d128c, f55413b, 46b02af, 74a5e9f, 9fc5759, 40cf7ba, 690be1d, 9c73b05, 49e8b0e | minilm-matcher, semantic-cache, session-store added; per-request token capture; picks slimmed by meaning |
| 2026-10-26 18:01 | 6cfa0bf | Snapshot: conditional-veg diet class live |
| 2026-10-26 17:48 | 5fd074c, 5715933 | veg-conditional diet class (mayo-dip cards) |
| 2026-10-26 17:42 | 8966db9, 4b4652f, eca51da, 33720d6 | Full corpus snapshot live (57+1 cards, 4468 videos); honest snapshot banner |
| 2026-10-26 17:38 | ffebbab, 57b9395, f1a47c8, d45aaa7, db7e5bf | Typo tolerance + transparent no-match |
| 2026-10-26 17:34 | eb26992 | Strict-veg regression tests |
| 2026-10-26 17:25 | 3ad474c, 0ce16ae, 4797957, 9db4fa7, 95a60c4, f049a59 | Encrypted comm trace + Comms tab |
| 2026-10-26 17:07 | f181262, 82a1c63, 4de206d, 0a66557, 73cde2d | Structured validated answers; inventory vs recommendation split |
| 2026-10-26 16:58 | 4047cd9, a92ddae, 8a16ff5 | Dish-aware no-repeat; stopword guard |
| 2026-10-26 16:52 | fe72437, 65ebae9, 2f4c6f1, a8e1984 | Ask route gets pick-grade constraints |
