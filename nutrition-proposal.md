# Nutrition presentation proposal (audit-gated, my call per main's ownership directive)

## Eligibility gate (semantic, not weight-coverage)
A card is eligible for published numbers only when NO semantically critical
ingredient (staple, protein, fat/oil/ghee/butter, dairy, nuts, sugar/jaggery,
main veg) is unresolved (no-qty / no-ref / no-density) and no deep-frying oil
was excluded. Recipe-optional ingredients and method notes do not gate.
Coverage % is reported internally but never used as the gate.

## Result
- 28 of 84 cards eligible (whole-batch macros + fibre, verified math).
- 56 ineligible: dominant causes are TRUE source gaps - unquantified oil/ghee/
  butter in source (16 cards), excluded deep-frying oil (14 cards), unquantified
  main ingredients (eggs, paneer, bread, rice), unsourced densities (poha cup,
  grated paneer cup, cashew paste dilution, "bowl" units), ambiguous sources
  (Kurkure 200g-vs-400g paneer contradiction).
- Of the 28 eligible: 7 carry proxy limitations (curd-from-milk, soya-chunks-from-
  defatted-soy-flour), 23 use >=1 approximated entry (oil, butter, sugar, curd).
- Volume normalization: cards whose source declares a 250 ml metric cup get USDA
  240 ml cup weights scaled x1.042 (logged per card).

## Presentation (per eligible card)
Whole-batch: kcal, protein, fat, carbs, fibre + visible portion_assumption
("whole recipe treated as N portions - assumption, not a stated yield") +
per-portion split of those same numbers + inline disclosures where they apply:
"curd estimated from milk", "soya chunks estimated from defatted soy flour",
"cup weights normalized to the source's 250 ml cup".
Micros: NOT presented anywhere - the reference table carries no verified
micronutrients; exact micros would be unsafe.
Ineligible cards: no numbers; composition + ingredients + portion pairing only
(current UI behaviour). Internal audit trail (skipped fragments + reasons) kept
per card for future closure.

## What this does NOT do
No personal calorie targets, no diet filtering (blocked on user's audience/
allergy answers), no health claims. Meal-plan compositions remain usable for
all 84 cards via defined transparent portions.
