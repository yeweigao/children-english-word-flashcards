// Drizzle schema for the children's English flashcard space.
//
// settings: one row (id=1) holding the child's Cambridge Young Learners
// level, used only to judge which words on a homework page are above level,
// plus the parent's auto-read switch: when on, display faces (front,
// card back, example deck, library expansion) read themselves aloud as
// they appear; production faces never auto-read.
// cards: one row per word card the parent confirmed. Learning state follows
// the book's rules: FSRS-style scheduling fields (stability, due_at) plus a
// four-scene mastery grid (scene_*): card recognition, sentence cloze,
// dictation, sentence-making. All four lit => graduated.
// reviews: one row per practice attempt (warmup choices never graduate a
// card; only "dig" modes and recall ratings move the schedule).
// activity: one row per local day, tracking whether the due queue was
// cleared (streak) and how many nearly-forgotten words were rescued.

import { integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  childLevel: text("child_level", {
    enum: ["starters", "movers", "flyers"],
  })
    .notNull()
    .default("movers"),
  autoRead: integer("auto_read").notNull().default(1),
});

export const cards = sqliteTable("cards", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  word: text("word").notNull(),
  phonetic: text("phonetic").notNull().default(""),
  pos: text("pos").notNull().default(""),
  meaningZh: text("meaning_zh").notNull().default(""),
  collocationsJson: text("collocations_json").notNull().default("[]"),
  examplesJson: text("examples_json").notNull().default("[]"),
  contrastWord: text("contrast_word"),
  contrastNoteZh: text("contrast_note_zh"),
  // "wrong" is legacy (pre-diagnosis cards filed straight from wrong
  // exercises); new cards are "spelling" / "meaning" / "above" / "manual".
  sourceType: text("source_type", {
    enum: ["wrong", "spelling", "meaning", "above", "manual"],
  }).notNull(),
  sourceRef: text("source_ref").notNull().default(""),
  wordLevel: text("word_level").notNull().default(""),
  state: text("state", { enum: ["new", "learning", "graduated"] })
    .notNull()
    .default("new"),
  stability: real("stability").notNull().default(0),
  dueAt: integer("due_at").notNull().default(0),
  reps: integer("reps").notNull().default(0),
  lapses: integer("lapses").notNull().default(0),
  sceneCard: integer("scene_card").notNull().default(0),
  sceneCloze: integer("scene_cloze").notNull().default(0),
  sceneDictation: integer("scene_dictation").notNull().default(0),
  sceneSentence: integer("scene_sentence").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export const reviews = sqliteTable("reviews", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  cardId: integer("card_id").notNull(),
  // "speak" is a legacy value: read-aloud / say-the-word reviews were
  // recorded before the feature was removed (speech recognition was
  // too unreliable in the field). Historical rows keep the value; no
  // new ones are written.
  mode: text("mode", {
    enum: ["warmup", "cloze", "dictation", "sentence", "recall", "speak"],
  }).notNull(),
  correct: integer("correct").notNull().default(0),
  typedAnswer: text("typed_answer"),
  rating: text("rating"),
  // Where the rating came from. "self" = the child's own tap on the old
  // self-rating buttons (historical rows only; the buttons are gone).
  // "behavior" = derived server-side from the observed attempt
  // (first-attempt correctness, attempts, hint use, typo tolerance,
  // first-response latency vs the child's own baseline). Null on
  // log-only rows (warmup taps) that carry no grade.
  gradeSource: text("grade_source", { enum: ["self", "behavior"] }),
  // The raw behavior record behind a behavior-derived grade, as JSON:
  // per-scene first-attempt correctness, attempt counts, hint use,
  // typo tolerance, and time-to-first-response in ms. Stored whole so
  // the derivation rule can be revised later and historical grades
  // recomputed from evidence instead of being lost.
  behaviorJson: text("behavior_json"),
  // Legacy: why a spoken attempt (feature since removed) produced no
  // usable recognition. Kept so historical rows stay readable and the
  // data export stays complete; new reviews leave it null.
  speechFailureReason: text("speech_failure_reason", {
    enum: ["unavailable", "denied", "no_result"],
  }),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// findJobs / findJobPages: one row per photo batch submitted for
// word-finding. The parent approved TEMPORARY server-side storage of
// the photos (2026-11-11: 「可以临时存，识别完立刻删」) so recognition
// can finish server-side even if the page is closed. The page images
// live in find_job_pages (base64) and in ctx.blobs under
// findjob/<jobId>/page-<i>.jpg; both copies are deleted the moment
// the job reaches done/failed, and a lazy sweep on any job action
// deletes the photos of jobs stuck unfinished for over 30 minutes.
// result_json holds only the word result (candidates + made words) —
// never image data.
export const findJobs = sqliteTable("find_jobs", {
  id: text("id").primaryKey(),
  status: text("status", {
    enum: ["queued", "reading", "making", "done", "failed"],
  })
    .notNull()
    .default("queued"),
  pageCount: integer("page_count").notNull().default(0),
  level: text("level").notNull().default("movers"),
  photoKeysJson: text("photo_keys_json").notNull().default("[]"),
  analysisJson: text("analysis_json"),
  resultJson: text("result_json"),
  error: text("error"),
  photosDeleted: integer("photos_deleted").notNull().default(0),
  createdAtMs: integer("created_at_ms").notNull().default(0),
  updatedAtMs: integer("updated_at_ms").notNull().default(0),
});

export const findJobPages = sqliteTable("find_job_pages", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  jobId: text("job_id").notNull(),
  idx: integer("idx").notNull(),
  mimeType: text("mime_type").notNull(),
  imageBase64: text("image_base64").notNull(),
});

export const activity = sqliteTable("activity", {
  day: text("day").primaryKey(),
  hadDue: integer("had_due").notNull().default(0),
  dueCleared: integer("due_cleared").notNull().default(0),
  rescued: integer("rescued").notNull().default(0),
  rescuedIds: text("rescued_ids").notNull().default("[]"),
});
