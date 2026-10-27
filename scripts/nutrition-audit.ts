/** Nutrition audit: per-card estimate coverage against the live DB.
 *  Read-only. Run: DATABASE_URL=... npx tsx scripts/nutrition-audit.ts */
import { neon } from '@neondatabase/serverless';
import { estimateNutrition } from '../server/mealplan.js';

const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`SELECT recipe_name, meal_type, verified, ingredients FROM recipes`;
const buckets = { full: 0, high: 0, mid: 0, low: 0, none: 0 };
const unmapped: Record<string, number> = {};
const worst: [string, number][] = [];
for (const r of rows) {
  const e = estimateNutrition(String(r.ingredients || ''), 2);
  if (e.unavailable) buckets.none++;
  else if (e.coverage_pct >= 95) buckets.full++;
  else if (e.coverage_pct >= 80) buckets.high++;
  else if (e.coverage_pct >= 60) buckets.mid++;
  else buckets.low++;
  if (!e.unavailable) worst.push([String(r.recipe_name), e.coverage_pct]);
  // collect unmapped ingredient names for targeting
  for (const frag of String(r.ingredients || '').split(/[,\n;]| and /i)) {
    const cleaned = frag.replace(/^\s*\d+(\.\d+)?(\s*[-/]\s*\d+(\.\d+)?)?\s*/, '').replace(/^(kg|g|gm|gms|ml|l|ltr|tsp|tbsp|tablespoons?|teaspoons?|cups?|pinch|sprigs?|handful)\s+/i, '').trim().toLowerCase();
    if (cleaned && !/unspecified|salt|water|ice|hing|asafoetida/.test(cleaned)) {
      const est = estimateNutrition(cleaned.replace(/^/, '100g '), 1); // probe: does it map?
      if (est.unavailable) unmapped[cleaned] = (unmapped[cleaned] || 0) + 1;
    }
  }
}
console.log('cards:', rows.length);
console.log('coverage buckets (>=95, 80-94, 60-79, <60, no-estimate):', JSON.stringify(buckets));
worst.sort((a, b) => a[1] - b[1]);
console.log('lowest-coverage cards:', worst.slice(0, 12).map(([n, c]) => `${c}% ${n}`).join(' | '));
const top = Object.entries(unmapped).sort((a, b) => b[1] - a[1]).slice(0, 30);
console.log('top unmapped:', top.map(([k, v]) => `${v}x ${k}`).join(' | '));
