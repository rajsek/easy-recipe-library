export type SortKey = 'original' | 'name' | 'time-asc' | 'time-desc' | 'views' | 'newest';
export type TimeBucket = '' | 'quick' | 'over30' | 'over60' | 'unknown';

// Only a complete, explicitly stated duration is sortable. Segment timings,
// video lengths, and estimates are not substitutes for a cooking duration.
function statedCookRange(text: string): [number, number] | undefined {
  const s = String(text || '').trim();
  const match = s.match(/^(?:(?:chef|channel)\s+(?:states?|says?)\s*:\s*)?(?:(?:total|cooking|cook|ready in)\s*(?:time)?\s*:?\s*)?(\d+(?:\.\d+)?)(?:\s*(?:-|to|–)\s*(\d+(?:\.\d+)?))?\s*(minutes?|mins?|hours?|hrs?)\s*(?:\((?:channel's claim|stated)\))?\.?$/i);
  if (!match) return;
  const factor = /^h/i.test(match[3]) ? 60 : 1;
  const low = Number(match[1]) * factor;
  const high = Number(match[2] || match[1]) * factor;
  return low > 0 && high >= low && high < 1440 ? [low, high] : undefined;
}

// Use the upper end to order a stated range, without estimating a midpoint.
export function statedCookMinutes(text: string): number | undefined {
  return statedCookRange(text)?.[1];
}

// Only a source-provided publish date is sortable; display formats and
// missing values stay unknown and sort last. No date is ever guessed.
export function publishedTime(raw: unknown): number | undefined {
  const s = String(raw ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:[T ].*)?$/.test(s)) return;
  const t = Date.parse(s.length === 10 ? s + 'T00:00:00Z' : s);
  return Number.isFinite(t) ? t : undefined;
}

export function viewCount(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  const s = String(raw ?? '').replace(/,/g, '').trim();
  if (!/^\d+$/.test(s)) return;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : undefined;
}

export function sortedResults<T>(
  items: T[], sort: SortKey, bucket: TimeBucket,
  fields: (x: T) => { name: string; time?: string; views?: unknown; published?: unknown }
): T[] {
  const rows = items.map((x, i) => {
    const value = fields(x);
    return { x, i, ...value, range: statedCookRange(value.time || ''), count: viewCount(value.views), published: publishedTime(value.published) };
  }).filter(r => {
    if (!bucket) return true;
    if (bucket === 'unknown') return !r.range;
    if (!r.range) return false;
    const [low, high] = r.range;
    return bucket === 'quick' ? low >= 10 && high <= 15 : low > (bucket === 'over30' ? 30 : 60);
  });
  const numeric = (a: number | undefined, b: number | undefined, desc = false) =>
    a === undefined ? (b === undefined ? 0 : 1) : b === undefined ? -1 : desc ? b - a : a - b;
  rows.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name)
    : sort === 'time-asc' ? numeric(a.range?.[1], b.range?.[1])
    : sort === 'time-desc' ? numeric(a.range?.[1], b.range?.[1], true)
    : sort === 'views' ? numeric(a.count, b.count, true)
    : sort === 'newest' ? numeric(a.published, b.published, true) : 0) || a.i - b.i);
  return rows.map(r => r.x);
}
