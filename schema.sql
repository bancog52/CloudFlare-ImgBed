CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY,
  file_name TEXT NOT NULL,
  folder TEXT NOT NULL DEFAULT '',
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  width INTEGER,
  height INTEGER,
  primary_channel TEXT NOT NULL,
  tg_file_id TEXT,
  tg_chunks TEXT,
  backup_status TEXT NOT NULL DEFAULT 'none',
  backup_error TEXT,
  original_name TEXT,
  original_mime TEXT,
  original_size INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_images_created ON images(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_images_folder ON images(folder, created_at DESC);
