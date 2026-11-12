DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE settings (
  id INTEGER PRIMARY KEY,
  child_level TEXT NOT NULL DEFAULT 'movers'
);
--> statement-breakpoint
CREATE TABLE cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  word TEXT NOT NULL,
  phonetic TEXT NOT NULL DEFAULT '',
  pos TEXT NOT NULL DEFAULT '',
  meaning_zh TEXT NOT NULL DEFAULT '',
  collocations_json TEXT NOT NULL DEFAULT '[]',
  examples_json TEXT NOT NULL DEFAULT '[]',
  contrast_word TEXT,
  contrast_note_zh TEXT,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL DEFAULT '',
  word_level TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'new',
  stability REAL NOT NULL DEFAULT 0,
  due_at INTEGER NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  scene_card INTEGER NOT NULL DEFAULT 0,
  scene_cloze INTEGER NOT NULL DEFAULT 0,
  scene_dictation INTEGER NOT NULL DEFAULT 0,
  scene_sentence INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  mode TEXT NOT NULL,
  correct INTEGER NOT NULL DEFAULT 0,
  typed_answer TEXT,
  rating TEXT,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE activity (
  day TEXT PRIMARY KEY,
  had_due INTEGER NOT NULL DEFAULT 0,
  due_cleared INTEGER NOT NULL DEFAULT 0,
  rescued INTEGER NOT NULL DEFAULT 0,
  rescued_ids TEXT NOT NULL DEFAULT '[]'
);
