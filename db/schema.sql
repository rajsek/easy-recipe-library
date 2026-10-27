-- Easy Recipe Library - Postgres/Neon schema (one table per former Sheet tab).
-- Columns mirror the Sheet headers 1:1 as TEXT; `seq` preserves insertion order
-- (the app relies on readTab returning rows in append order).

CREATE TABLE IF NOT EXISTS videos (
  seq BIGSERIAL PRIMARY KEY,
  video_id TEXT, title TEXT, channel TEXT, url TEXT, thumbnail_url TEXT,
  duration_s TEXT, views TEXT, category TEXT, diet_hint TEXT,
  yt_publish_date TEXT, date_first_added TEXT, date_last_checked TEXT,
  extraction_status TEXT
);
CREATE INDEX IF NOT EXISTS videos_video_id_idx ON videos (video_id);

CREATE TABLE IF NOT EXISTS recipes (
  seq BIGSERIAL PRIMARY KEY,
  recipe_name TEXT, video_url TEXT, channel TEXT, diet TEXT, meal_type TEXT,
  time_notes TEXT, ingredients TEXT, steps TEXT, source_note TEXT,
  verified TEXT, date_checked TEXT,
  -- Exact source wording of the stated yield when the video/description says
  -- one ('makes 12 dosas', 'serves 3-4'); NULL when unstated. Never parsed
  -- into a number: '12 dosas' and 'serves 3' are not interchangeable.
  stated_yield TEXT
);

-- profile is a self-declared label for logical per-name separation on shared
-- devices (NOT an auth boundary). Rows with '' predate profiles and stay in
-- the default namespace.
CREATE TABLE IF NOT EXISTS history (
  seq BIGSERIAL PRIMARY KEY,
  date TEXT, video_id TEXT, title TEXT, state TEXT, notes TEXT,
  profile TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS picks (
  seq BIGSERIAL PRIMARY KEY,
  date TEXT, filters TEXT, note TEXT, suggested_video_ids TEXT,
  chosen_video_id TEXT, suggested_titles TEXT,
  profile TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS queue (
  seq BIGSERIAL PRIMARY KEY,
  request_id TEXT, ts TEXT, diet TEXT, meal TEXT, note TEXT,
  status TEXT, answer TEXT, reserved TEXT,
  profile TEXT NOT NULL DEFAULT ''
);
ALTER TABLE history ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT '';
ALTER TABLE picks ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT '';
ALTER TABLE queue ADD COLUMN IF NOT EXISTS profile TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS rawextracts (
  seq BIGSERIAL PRIMARY KEY,
  video_id TEXT, title TEXT, channel_hint TEXT, yt_publish_date TEXT,
  description TEXT, transcript TEXT, extracted_at TEXT, parse_status TEXT
);
CREATE INDEX IF NOT EXISTS rawextracts_video_id_idx ON rawextracts (video_id);

-- Per-profile app settings (plan prefs etc.): remembered by name across devices.
CREATE TABLE IF NOT EXISTS settings (
  profile TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (profile, key)
);
