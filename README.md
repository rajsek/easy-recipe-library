# Easy Recipe Library

A small web app that suggests easy Indian evening snacks, breakfasts and Sunday
meals from a curated library of YouTube recipes - and never repeats a
suggestion within 30 days.

- **Pick for me** gives up to 5 ideas from *verified* recipes only (filters:
  veg/non-veg, meal type, free-text note). If fewer than 5 qualify, it says so -
  no filler.
- **No repeats**: any video suggested or cooked in the last 30 days is excluded.
  "Save for later" never excludes. A dish and its side from the same video
  (e.g. Pongal + Gotsu) count as one idea.
- **Library tabs**: snacks / breakfast / Sunday meals / sweets / all videos,
  with thumbnails that open the YouTube video.
- **Recipe cards**: ingredients, steps and cooking times read from each video's
  own subtitles. Chef-stated times and storage claims are labeled as the chef's
  claims; estimated totals are labeled as estimates. Recipes whose quantities
  come from auto-translated captions carry a "quantities partly approximate"
  badge and are never picked.
- **AI ranking is OFF by default** - see "AI picks" below.

## Quick start (demo mode, no Google account)

```bash
npm install
cp .env.example .env     # DATA_MODE=demo is the default
npm run dev              # API on :3000, web on :5173 (opens the app)
```

or a production-style local run:

```bash
npm run build && npm start   # serves everything on http://localhost:3000
```

Demo mode uses bundled demo data - a small set of example recipe cards
summarized from public YouTube videos (each card links its source video;
recipes belong to their channels), a sample video index, and synthetic
history seeds. Button writes stay in memory only. It never touches a real
Sheet.

## Using your own Google Sheet (DATA_MODE=sheets)

The app reads four tabs - `Videos`, `Recipes`, `History`, `Picks` - with the
header row as field names. Your Sheet stays private.

**This step is your decision.** Connecting a Sheet means giving a server
identity standing read/write access to it - including your cooking history.
Do this only if you want the app backed by your own data; demo mode needs no
Google account at all.

Two ways exist; **only the first is implemented** in this version:

1. **Service account (implemented).** You share the Sheet once with a robot
   identity's email. Simple and unattended, but it is a *standing* share you
   manage from the Sheet's Share dialog - revoke it there at any time.
2. **OAuth "sign in as yourself" (not implemented here).** Google's Node
   quickstart shows the alternative: the app would open a browser consent
   screen and store a refresh token acting as *you*
   (<https://developers.google.com/sheets/api/quickstart/nodejs>). No standing
   share with a second identity, but the app would see every Sheet you can.
   This version does not include that flow.

Service account setup:

1. In [Google Cloud Console](https://console.cloud.google.com), create a
   project (or reuse one) and enable the **Google Sheets API**.
2. Create a **service account**, then create and download its JSON key.
3. In your Sheet, click **Share** and add the service account's email
   (ends in `@<project>.iam.gserviceaccount.com`) as **Editor**.
4. Fill `.env`:
   ```
   DATA_MODE=sheets
   SHEET_ID=<the long ID from your Sheet's URL>
   GOOGLE_SERVICE_ACCOUNT_JSON=<the key JSON on one line>
   ```
   (or point `GOOGLE_APPLICATION_CREDENTIALS` at the downloaded file)
5. `npm run build && npm start`.

The service account sees only Sheets you share with it. `.env` is gitignored;
never commit real credentials.

## AI picks (optional, off by default)

Without AI, picks are deterministic and unranked and the app says so. To enable
AI ranking, set both:

```
AI_PROVIDER=gemini
GEMINI_API_KEY=<your key>
```

Privacy, so the choice is informed: **free-tier** Gemini API keys let Google
use submitted data to improve products, including human review
(<https://ai.google.dev/gemini-api/terms>). **Paid-tier** data is not used for
training. The app sends only the candidate list (public recipe data) plus that
request's filters and your note text - but it sends them only when you have
turned AI on. The 30-day exclusion always runs locally in `server/pick.ts`,
never in the model, and the model's picks are validated against the candidate
list before use. The key stays server-side; it is never sent to the browser.

## Security (read before deploying)

- **Local by default.** The server binds `127.0.0.1` unless you set `HOST`.
  On localhost it serves the app without a password - fine for your own
  computer.
- **Shared secret for anything wider.** If you set `HOST` to a non-local
  address (LAN or a public host), the server **refuses to start** unless
  `APP_TOKEN` is set. With `APP_TOKEN` set, every `/api` route requires the
  token - reads and writes alike. The web app handles this for you: it opens
  with an unlock screen, you enter the token once, and it is remembered in
  that browser's local storage (never sent anywhere except this server as an
  `Authorization: Bearer` header). Your Sheet contents and history are never
  exposed unauthenticated. Serve over HTTPS when hosting publicly, or the
  token travels in clear text.
- **Writes are validated and rate-limited.** Pick/history inputs are checked
  server-side; mutations are capped at 60 per 5 minutes per IP.
- **Keys stay server-side.** The service-account JSON and any Gemini key are
  read only by the server process; they are never sent to the browser and
  `.env` is gitignored.

## Deploying

Any Node 20+ host works: set the same `.env` values in the host's environment,
run `npm ci && npm run build`, and start with `npm start` (serves the API and
the built frontend on `$PORT`, default 3000). No public Sheet and no public
database are required.

### Vercel (serverless)

The repo is Vercel-ready: `server.ts` at the root re-exports the Express app
for Vercel's zero-config Express support, and `vercel.json` builds the
frontend into the function. Import the repo from GitHub, then set these
environment variables in the project settings (same meaning as `.env`):

- `DATA_MODE=live`, `SHEET_ID`, `GOOGLE_SERVICE_ACCOUNT_JSON` (the full
  service-account JSON on one line)
  - or, with the Postgres/Neon backend: `DATA_MODE=pg`, `DATABASE_URL`
  (a Neon pooled connection string; schema in `db/schema.sql`, one-time seed
  via `DATABASE_URL=... node scripts/seed-pg.mjs` using `db/seed-export.json`)
- `APP_TOKEN` - required here: serverless binds no fixed host, so the app
  relies on the token gate. The app opens with its unlock screen.

`npm start` still works unchanged for local and traditional hosts: when the
file is run directly it calls `listen()`; when a host imports it, it just
exports the app. Serverless notes: demo mode's in-memory picks/history do not
persist between function instances, so deploy with `DATA_MODE=live`; function
execution must finish within the host's time limit (Vercel Hobby allows
300s, far above this app's per-request Sheets calls). Cold starts can add a
short delay to the first request; this varies and is not guaranteed. For an
extra layer, Vercel's Deployment Protection ("All Deployments" scope with
Vercel Authentication, and one shareable link, are included on the free Hobby
plan) can gate the whole site in front of the app token.

An alternative Google-native deployment of the same UI (Apps Script web app,
no server to run) is in [`apps-script/`](apps-script/README.md). It cannot run
locally, which is why this standalone app exists.

## Development

```bash
npm run dev      # watch mode: tsx (API) + vite (web with /api proxy)
npm test         # pick-logic unit tests (node:test)
npm run build    # production web build to web/dist
```

Layout:

```
server/   Express API: data layer (demo | sheets), pick logic, tests
web/      React + Vite + TypeScript frontend
apps-script/  Same UI as a Google Apps Script web app (alternative deploy)
```

## Data and privacy boundary

- Recipe content is derived from public YouTube videos (titles, subtitles,
  descriptions) and keeps attribution to the source video.
- Your Sheet ID, history, picks and credentials live only in your `.env` and
  your private Sheet - never in this repository.
- Chef/channel claims (storage life, health) are reported as their claims, not
  as independent advice.

## Feature checklist (honest status)

| Feature | Status |
| --- | --- |
| Pick for me (no-repeat 30 days, one idea per video, max 5, honest shortfall) | Working; unit-tested and tested locally in a browser |
| Diet filters | Working and conservative: 'Veg' strict; 'Non-veg' needs an explicit egg/meat classification; unknown/unclassified diets match neither filter and appear only in unfiltered picks |
| Free-text note with AI off | Applied only as keyword rules ("no onion" excludes by ingredient text; plain words give a deterministic boost); the app states exactly what it did. Unparseable notes are ignored and reported as ignored |
| AI ranking | Coded (Gemini), OFF by default, untested end-to-end; needs your informed provider choice + key |
| Library tabs, recipe cards, partial-quantity badge | Working; tested locally in a browser |
| Save for later / Choose / Cooked buttons | Working; demo mode keeps them in memory, sheets mode appends to the Sheet |
| Sheets mode (your own data) | Coded against the Sheets API; NOT yet tested end-to-end (needs the service-account step above, which is your decision) |
| Video index refresh (finding new uploads on the channels) | NOT part of this app; done by a separate extraction workflow outside this repo |
| Ingredient-level grocery ordering | Not built |
| Deployment to a public host | Documented; not performed; requires APP_TOKEN (see Security) |
