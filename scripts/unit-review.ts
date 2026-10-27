/** Unit review: flag implausible parsed gram amounts per card. Read-only. */
import { neon } from '@neondatabase/serverless';
import { estimateNutrition } from '../server/mealplan.js';
// re-derive per-fragment grams using the same exported logic would need internals;
// instead flag via estimate invariants + pattern scan of risky phrasings.
const sql = neon(process.env.DATABASE_URL!);
const rows = await sql`SELECT recipe_name, ingredients FROM recipes`;
let flagged = 0;
for (const r of rows) {
  const ing = String(r.ingredients || '');
  const flags: string[] = [];
  for (const frag of ing.split(/[,\n;]| \+ | and /i)) {
    const f = frag.trim();
    // spices/herbs in cup or tbsp quantities > 2 tbsp equivalent
    if (/(pepper|cumin|jeera|turmeric|mustard|cardamom|clove|chilli|chili|fenugreek|vendhayam|elaichi|cinnamon|patta|star anise|saunf|fennel|ajwain|omam|masala|powder)/i.test(f)) {
      const m = f.match(/(\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:\.\d+)?)/);
      if (m && /cup/i.test(f) && parseFloat(m[1]) >= 1) flags.push('CUP-SPICE: ' + f.slice(0, 60));
      if (m && /\b(g|gm)\b/i.test(f) && parseFloat(m[1]) > 60) flags.push('BIG-SPICE: ' + f.slice(0, 60));
    }
    // huge single quantities
    const mg = f.match(/(\d+(?:\.\d+)?)\s*(kg|g|gm)\b/i);
    if (mg) { const grams = parseFloat(mg[1]) * (mg[2].toLowerCase()==='kg'?1000:1); if (grams > 1500) flags.push('HUGE: ' + f.slice(0, 60)); }
  }
  if (flags.length) { flagged++; console.log('==', r.recipe_name); flags.forEach(x => console.log('   ', x)); }
}
console.log('flagged cards:', flagged, 'of', rows.length);
