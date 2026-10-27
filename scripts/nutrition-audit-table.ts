/** Per-card audit table with a SEMANTIC eligibility gate.
 *  A card is eligible for published whole-batch macros only when no
 *  semantically critical ingredient went unresolved (weight coverage alone
 *  is NOT the gate): unquantified/unc mapped staples, proteins, fats, or
 *  excluded deep-frying oil make exact calorie claims unsafe.
 *  Run: DATABASE_URL=... npx tsx scripts/nutrition-audit-table.ts > out.json */
import { neon } from '@neondatabase/serverless';
import { estimateNutrition } from '../server/mealplan.js';

const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`SELECT recipe_name, meal_type, diet, verified, ingredients FROM recipes ORDER BY recipe_name`;
const out = [];
for (const r of rows) {
  const ing = String(r.ingredients || '');
  const e = estimateNutrition(ing);
  const ineligible: string[] = e.ineligible_reasons;
  out.push({
    card: r.recipe_name, meal: r.meal_type, diet: r.diet, verified: r.verified,
    eligible: ineligible.length === 0,
    ineligible_reasons: ineligible,
    whole_recipe: e.unavailable ? null : { kcal: e.kcal, protein_g: e.protein_g, fat_g: e.fat_g, carb_g: e.carb_g, fibre_g: e.fibre_g },
    coverage_pct: e.coverage_pct,
    approx_used: e.approx_used,
    proxy_limitations: e.proxies,
    notes: e.notes,
    skipped: e.skipped,
  });
}
const el = out.filter(r => r.eligible);
console.log(JSON.stringify({
  summary: {
    cards: out.length, eligible: el.length, ineligible: out.length - el.length,
    eligible_with_proxy_limitations: el.filter(r => r.proxy_limitations.length).length,
    eligible_with_approx_entries: el.filter(r => r.approx_used).length,
  },
  ineligible_cards: out.filter(r => !r.eligible).map(r => ({ card: r.card, reasons: r.ineligible_reasons })),
  cards: out,
}, null, 1));
