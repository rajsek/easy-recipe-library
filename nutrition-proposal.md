# Nutrition presentation proposal (audit-gated, my call per main's ownership directive)

## Eligibility gate (semantic, not weight-coverage)
A card is eligible for published numbers only when NO semantically critical
ingredient (staple, protein, fat/oil/ghee/butter, dairy, nuts, sugar/jaggery,
main veg) is unresolved (no-qty / no-ref / no-density) and no deep-frying oil
was excluded. Recipe-optional ingredients and method notes do not gate.
Coverage % is reported internally but never used as the gate.

## Result (current, verified against live data)
- 9 of 84 cards eligible (stricter proxy gate: portion weights or entries borrowed
  from a different food make a card ineligible - e.g. cup-quantified dal whose cup
  weight comes from lentils). Numbers shown as WHOLE-BATCH totals only; a
  user-selected "Share of batch" calculator (1/2, 1/3, 1/4, 1/6) divides those
  same totals as labeled arithmetic, never a serving recommendation. No recipe
  yield is recorded; the UI says "Source yield hasn't been recorded".
- 75 ineligible: dominant causes are TRUE source gaps - unquantified oil/ghee/
  butter in source, excluded deep-frying oil, unquantified main ingredients,
  unsourced densities (poha cup, "bowl" units), ambiguous sources.
- Volume normalization: cards whose source declares a 250 ml metric cup get USDA
  240 ml cup weights scaled x1.042 (logged per card).

## Minerals (bounded subset, shipped)
- Five minerals per eligible card (calcium, iron, magnesium, potassium, zinc) as
  RAW-INGREDIENT SUMS from USDA FDC per-100g values, labeled in the UI as an
  ingredient-sum estimate with cooking/leaching losses not modeled.
- Provenance: 35 of 71 reference entries carry micros, each with a micro_source
  field. 34 come from USDA FDC (SR Legacy / FNDDS). Jaggery uses IFCT 2017
  (NIN/ICMR, Table 5, food I001 "Jaggery, cane (Saccharum officinarum)", N=6
  regional composite samples, mg/100g, https://www.nin.res.in/ebooks/IFCT2017.pdf)
  after primary-table verification - a search hit alone would not have been
  enough (a secondary site and the book's own historical intro quote a stale
  11.4 mg iron figure; the 2017 analyzed value is 4.63 mg). Every matched
  ingredient on the 9 eligible cards is now covered. Curry leaves are
  quantity-negligible and never enter the sums. If a future recipe adds a
  matched ingredient with no verified micro entry, that card's mineral line is
  labeled "partial - known ingredients only" and names the exclusion.
- Sodium is shown ONLY when the source quantifies its salt (e.g. "1 tsp salt",
  converted with reference gram weights - 6 g/tsp from USDA FDC 173468 portion
  data - plus raw ingredient sodium; the UI says exactly that, not "measured").
  Cards whose source has no quantified salt (Navratan Pulao, Sambar Sadam)
  withhold sodium entirely; the UI says why.
- Vitamins: not estimated anywhere - cooking retention evidence is insufficient,
  the UI says "Vitamins: unavailable (cooking retention evidence insufficient)".

## What this does NOT do
No personal adequacy or %daily-target claims, no measured-cooked-nutrition
claims, no estimated salt, no diet filtering (blocked on user's audience/
allergy answers), no health claims. Meal-plan compositions remain usable for
all 84 cards via defined transparent portions.
