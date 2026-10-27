export type SortKey = 'original' | 'name' | 'time-asc' | 'time-desc' | 'views' | 'newest';
// Bins match the data we actually have (recipe-linked durations cluster under
// 30 min). A stated cook time always wins; when none is stated the LINKED
// VIDEO's length is the fallback criterion - labelled, never silent.
export type TimeBucket = '' | 'quick' | 'mid' | 'over30' | 'unknown';
export const TIME_BUCKET_LABELS: Record<Exclude<TimeBucket, ''>, string> = {
  quick: 'Up to 15 minutes', mid: '15-30 minutes', over30: 'More than 30 minutes', unknown: 'Not stated / unknown',
};
function bucketOf(minutes: number): Exclude<TimeBucket, ''> {
  return minutes <= 15 ? 'quick' : minutes <= 30 ? 'mid' : 'over30';
}
/** Minutes usable for time filtering: stated cook time first, else the linked
 *  video's duration in seconds. source tells the UI which one it is. */
export function filterMinutes(time: string | undefined, durationS?: unknown): { minutes: number; source: 'stated' | 'video' } | undefined {
  const stated = statedCookMinutes(time || '');
  if (stated !== undefined) return { minutes: stated, source: 'stated' };
  const s = String(durationS ?? '').trim();
  if (!/^\d+$/.test(s)) return;
  const m = Math.round(Number(s) / 60);
  return m > 0 ? { minutes: m, source: 'video' } : undefined;
}

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
  fields: (x: T) => { name: string; time?: string; duration_s?: unknown; views?: unknown; published?: unknown }
): T[] {
  const rows = items.map((x, i) => {
    const value = fields(x);
    return { x, i, ...value, range: statedCookRange(value.time || ''), filter: filterMinutes(value.time, value.duration_s), count: viewCount(value.views), published: publishedTime(value.published) };
  }).filter(r => {
    if (!bucket) return true;
    if (bucket === 'unknown') return !r.filter;
    // Overlap rule: a stated range appears in every bucket it touches, so a
    // known range is never silently dropped from filtering. Bucket intervals:
    // quick (0,15], mid (15,30], over30 (30,+inf) - boundary-touching counts
    // as the lower bucket only (positive-width overlap).
    if (r.range) {
      const [low, high] = r.range;
      if (bucket === 'quick') return low < 15;
      if (bucket === 'mid') return low < 30 && high > 15;
      return high > 30; // over30
    }
    if (!r.filter) return false;
    return bucketOf(r.filter.minutes) === bucket;
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
