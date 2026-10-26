# Easy Recipe Library

A private recipe library and meal picker for one household, built on Google
Sheets (data) and Google Apps Script (app). Veg and non-veg South Indian
recipes (plus a German baking channel), collected from four YouTube channels:
Venkatesh Bhat, Chef Damu, HomeCookingShow and Hausgemachte Rezepte.

## What works today

- A catalog of 4,468 YouTube videos with title, channel, link, thumbnail,
  duration, views, category and veg/non-veg hint.
- A growing set of checked recipes (ingredients with quantities, steps,
  cooking-time notes) - each one read from the video's own description or
  subtitles, never guessed from a title. See the Recipes tab of the Sheet.
- Raw captured transcripts/descriptions per video (RawExtracts tab), kept
  clearly separate from checked recipes.
- History: saved-for-later / chosen / cooked / suggested stay separate;
  nothing suggested or cooked repeats within 30 days.
- The app (apps-script/) shows the catalog with filters and search, the
  checked recipes, history, and a "Pick for me" that returns up to 5
  non-repeating ideas from checked recipes.

## What is not finished

- Most of the 4,468 videos are catalog entries only; checked recipes are
  added continuously (current count is in the Sheet's Recipes tab).
- AI-ranked picks are OFF by default. The app supports a server-side
  provider (Gemini) that the owner can enable after choosing the data terms
  they are comfortable with. Until then, picks are unranked matches and the
  chat assistant gives reasoned picks instead.
- Grocery ordering (Amazon Now / Swiggy Instamart) is planned, not built.
  Every order would need explicit approval before checkout.

## Layout

- `apps-script/Code.gs` - server: Sheet access, filters, history, picks.
- `apps-script/Index.html` - the app UI (mobile-first).

## Deploy (owner's Google account, one time)

1. Create a Google Sheet with the tabs described below (or your copy of the recipe data Sheet), then open Extensions > Apps Script.
2. Paste `Code.gs` and add an `Index.html` file with the other file's content.
3. Deploy > New deployment > Web app > Execute as: **Me** > Who has access:
   **Only myself**.
4. Updates: create a new version and edit the deployment to it - the URL
   never changes.

## Data honesty

- `yt_publish_date` is filled only where the exact date was seen on the
  video's watch page; blank elsewhere.
- Cooking times are labeled: chef-stated vs estimated.
- No recipe detail is ever invented to fill a gap.
