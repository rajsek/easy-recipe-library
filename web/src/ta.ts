// Shared typeahead matching + keyboard navigation. Used by BOTH the
// ingredient filter (inside the note input) and the dish filter, so the two
// can never drift into different semantics. Pure functions, no AI calls.
export function taFilter(vocab: string[], token: string, max = 6): string[] {
  const t = token.trim().toLowerCase();
  if (t.length < 2) return [];
  const prefix = vocab.filter((v) => v.toLowerCase().startsWith(t));
  const inner = vocab.filter((v) => !v.toLowerCase().startsWith(t) && v.toLowerCase().indexOf(t) !== -1);
  return [...prefix, ...inner].slice(0, max);
}

export type TaNav = { type: 'move'; index: number } | { type: 'pick'; index: number } | null;

// ArrowUp/ArrowDown move (wrapping); Enter/Tab pick the active row; anything
// else is not ours to handle. Escape is handled by the caller (close only).
export function taNav(key: string, index: number, len: number): TaNav {
  if (len <= 0) return null;
  if (key === 'ArrowDown') return { type: 'move', index: (index + 1) % len };
  if (key === 'ArrowUp') return { type: 'move', index: (index - 1 + len) % len };
  if (key === 'Enter' || key === 'Tab') return { type: 'pick', index };
  return null;
}

// Single selection-toggle used by the chips AND the checkbox lists, so the
// two can never disagree: checked <=> chip present, always.
export function toggleSel(list: string[], item: string): string[] {
  return list.indexOf(item) !== -1 ? list.filter((x) => x !== item) : [...list, item];
}

// Compose the free-text note sent to /api/pick and /api/ask-ai. Selected
// ingredient chips lead, then any dish text TYPED into the dish box: the
// select list is optional, so a typed-but-unselected dish or ingredient
// (e.g. "beetroot", which no chip exists for) must still be searched.
// Server-side these words hard-match recipe name AND ingredients, and a
// no-match is an honest zero, never an unrelated fallback. Case-insensitive
// dedup so a word picked as a chip and also typed is not sent twice.
export function composePickNote(ings: string[], free: string, typedDish: string): string {
  const seen: Record<string, true> = {};
  const parts: string[] = [];
  for (const w of [...ings, typedDish]) {
    const t = w.trim();
    const k = t.toLowerCase();
    if (!t || seen[k]) continue;
    seen[k] = true;
    parts.push(t);
  }
  const head = parts.join(', ');
  const f = free.trim();
  // Same words typed in both boxes collapse to one mention.
  if (f && f.toLowerCase() === head.toLowerCase()) return head;
  return head + (f ? (head ? ' - ' : '') + f : '');
}
