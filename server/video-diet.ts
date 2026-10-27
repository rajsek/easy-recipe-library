// Title evidence can downgrade a source hint, never establish egg-free status
// for an unknown video. Keep this guard shared by listing and retrieval.
export function videoDietHint(title: string, hint: string): string {
  const text = String(title || '').toLowerCase();
  const withoutEggFreeClaims = text.replace(/\begg[ -]?less\b|\begg[ -]?free\b|\bno eggs?\b|\bwithout eggs?\b|\bohne (?:ei|eier)\b/g, '');
  if (/\b(?:chicken|mutton|fish|prawns?|shrimp|beef|pork|bacon|ham|salmon|tuna|hähnchen|huhn|fleisch|fisch)\b/.test(text)) return 'non-veg';
  if (/\b(?:eggs?|ei|eier|omelette|omelet)\b/.test(withoutEggFreeClaims)) return 'Contains egg';
  const normalized = String(hint || '').trim().toLowerCase();
  if (normalized === 'veg') return 'veg';
  if (/egg/.test(normalized)) return 'Contains egg';
  if (/^(?:non-?veg|chicken|mutton|fish|prawn|meat)$/.test(normalized)) return 'non-veg';
  return '';
}
export function videoMatchesDiet(title: string, hint: string, diet: string): boolean {
  const safe = videoDietHint(title, hint);
  if (!diet) return true;
  if (diet.toLowerCase() === 'veg') return safe === 'veg';
  if (/^(?:egg|contains egg)$/i.test(diet)) return safe === 'Contains egg';
  if (/^non-?veg$/i.test(diet)) return safe === 'non-veg' || safe === 'Contains egg';
  return false;
}
