/**
 * Postgres/Neon-backed storage (MODE=pg).
 *
 * Implements the same two-primitive surface the server uses everywhere:
 *   readTab(name)   -> array of header-keyed row objects, in insertion order
 *   appendRow(name) -> append one row (positional values, same order as cols)
 *
 * Connection: DATABASE_URL (Neon pooled connection string).
 * Driver: @neondatabase/serverless SQL-over-HTTP (no sockets, Vercel-safe).
 *
 * Tables are created by db/schema.sql; seed from db/seed-export.json via
 * scripts/seed-pg.mjs. One table per Sheet tab, columns mirror the Sheet
 * headers 1:1, plus a bigserial `seq` that preserves insertion order.
 */
import { neon } from '@neondatabase/serverless';

/** Minimal SQL-over-HTTP client shape (neon().query); injectable for tests. */
export interface PgClient { query(text: string, values?: any[]): Promise<any>; }

export interface PgTab { table: string; cols: string[]; }

export const PG_TABS: Record<string, PgTab> = {
  Videos: { table: 'videos', cols: ['video_id','title','channel','url','thumbnail_url','duration_s','views','category','diet_hint','yt_publish_date','date_first_added','date_last_checked','extraction_status'] },
  Recipes: { table: 'recipes', cols: ['recipe_name','video_url','channel','diet','meal_type','time_notes','ingredients','steps','source_note','verified','date_checked'] },
  History: { table: 'history', cols: ['date','video_id','title','state','notes'] },
  Picks: { table: 'picks', cols: ['date','filters','note','suggested_video_ids','chosen_video_id','suggested_titles'] },
  Queue: { table: 'queue', cols: ['request_id','ts','diet','meal','note','status','answer','reserved'] },
  RawExtracts: { table: 'rawextracts', cols: ['video_id','title','channel_hint','yt_publish_date','description','transcript','extracted_at','parse_status'] },
};

/** Pure: build a parameterized INSERT for one row (values in PG_TABS column order). */
export function buildInsert(tab: PgTab, row: Array<string | null>): { text: string; values: Array<string | null> } {
  const cols = tab.cols;
  const values = cols.map((_, i) => (i < row.length ? row[i] : null));
  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  const text = `INSERT INTO ${tab.table} (${cols.join(', ')}) VALUES (${placeholders})`;
  return { text, values };
}

/** Pure: map raw query rows (arrays or objects) to header-keyed objects; null -> ''. */
export function rowsToObjects(cols: string[], rows: any[]): Array<Record<string, string>> {
  return rows.map((r) => {
    const o: Record<string, string> = {};
    for (const c of cols) {
      const v = Array.isArray(r) ? r[cols.indexOf(c)] : r?.[c];
      o[c] = v == null ? '' : String(v);
    }
    return o;
  });
}

export interface PgStore {
  readTab(name: string): Promise<Array<Record<string, string>>>;
  appendRow(name: string, row: Array<string | null>): Promise<void>;
}

/** Live store: SQL-over-HTTP against DATABASE_URL. One call = one HTTP query. */
export function createPgStore(url: string, client?: PgClient): PgStore {
  const sql: PgClient = client || neon(url);
  return {
    async readTab(name) {
      const tab = PG_TABS[name];
      if (!tab) return [];
      const rows = (await sql.query(`SELECT ${tab.cols.join(', ')} FROM ${tab.table} ORDER BY seq`)) as any[];
      return rowsToObjects(tab.cols, rows);
    },
    async appendRow(name, row) {
      const tab = PG_TABS[name];
      if (!tab) throw new Error(`pg: unknown tab ${name}`);
      const q = buildInsert(tab, row);
      await sql.query(q.text, q.values as any[]);
    },
  };
}
