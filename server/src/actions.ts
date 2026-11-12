// Actions for 儿童英语单词闪卡.
//
// Product rules (from the spec rewritten after 《AI 英语学习手册》):
// - Words come from the child's own homework page, but a wrong exercise is
//   NOT a misspelled word: the vision model first diagnoses WHY each wrong
//   exercise went wrong, and only a lexical root cause (spelling, meaning,
//   confusion, collocation, phrase concept) — or an above-level key word —
//   earns a card. Parents confirm before cards are made.
// - Cards are born in sentences: example-first card faces, collocations as
//   "partitions", confusable pairs get a contrast card with the reason in
//   Chinese (borrow vs lend is about direction).
// - Scheduling is FSRS, and FSRS only: the due queue is settled first;
//   the grade that drives it is derived server-side from observed
//   behavior (first-attempt correctness, attempts, hints, typo
//   tolerance, first-response latency vs the child's own baseline) —
//   the child never self-rates, and no side rule touches due dates.
//   Mastery needs four scenes (recognise / cloze / dictation / make a
//   sentence); multiple choice is warm-up evidence only and never
//   graduates a card by itself.
// - The error archive keeps fingerprints (confusion pairs, spelling tails,
//   stubborn words); everything exports as JSON.

import { defineAction, z, type ActionsModule, type Ctx } from "@hatch/space-sdk";
import { privileged } from "@space/privileged";
import { asc, desc, eq } from "drizzle-orm";
import * as schema from "./schema";

/* ------------------------------------------------------------------ */
/* Shared shapes                                                       */
/* ------------------------------------------------------------------ */

const collocationSchema = z.object({
  phrase: z.string(),
  meaningZh: z.string(),
});
const exampleSchema = z.object({ en: z.string(), zh: z.string() });

const cardSchema = z.object({
  id: z.number(),
  word: z.string(),
  phonetic: z.string(),
  pos: z.string(),
  meaningZh: z.string(),
  collocations: z.array(collocationSchema),
  examples: z.array(exampleSchema),
  contrastWord: z.string().nullable(),
  contrastNoteZh: z.string().nullable(),
  // "wrong" is a legacy value from before the diagnosis rework: cards
  // created then were filed straight from wrong exercises. New cards
  // use "spelling" (the word itself was misspelled) or "meaning" (the
  // diagnosis was lexical — meaning / confusion / phrase concept).
  sourceType: z.enum(["wrong", "spelling", "meaning", "above", "manual"]),
  sourceRef: z.string(),
  wordLevel: z.string(),
  state: z.enum(["new", "learning", "graduated"]),
  dueAt: z.number(),
  reps: z.number(),
  lapses: z.number(),
  scenes: z.object({
    card: z.boolean(),
    cloze: z.boolean(),
    dictation: z.boolean(),
    sentence: z.boolean(),
  }),
});
type CardOut = z.infer<typeof cardSchema>;

type CardRow = typeof schema.cards.$inferSelect;

function parseJsonArray<T>(raw: string, fallback: T[]): T[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? (v as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function rowToCard(row: CardRow): CardOut {
  return {
    id: row.id,
    word: row.word,
    phonetic: row.phonetic,
    pos: row.pos,
    meaningZh: row.meaningZh,
    collocations: parseJsonArray<{ phrase: string; meaningZh: string }>(
      row.collocationsJson,
      [],
    ),
    examples: parseJsonArray<{ en: string; zh: string }>(row.examplesJson, []),
    contrastWord: row.contrastWord,
    contrastNoteZh: row.contrastNoteZh,
    sourceType: row.sourceType,
    sourceRef: row.sourceRef,
    wordLevel: row.wordLevel,
    state: row.state,
    dueAt: row.dueAt,
    reps: row.reps,
    lapses: row.lapses,
    scenes: {
      card: row.sceneCard === 1,
      cloze: row.sceneCloze === 1,
      dictation: row.sceneDictation === 1,
      sentence: row.sceneSentence === 1,
    },
  };
}

const DAY_MS = 86_400_000;

function dayStartMs(day: string): number {
  const d = new Date(`${day}T00:00:00`);
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

async function getLevel(ctx: Ctx): Promise<"starters" | "movers" | "flyers"> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.settings);
  const row = rows[0];
  if (!row) {
    await db.insert(schema.settings).values({ id: 1, childLevel: "movers" });
    return "movers";
  }
  return row.childLevel;
}

async function getAutoRead(ctx: Ctx): Promise<boolean> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.settings);
  const row = rows[0];
  if (!row) {
    await db.insert(schema.settings).values({ id: 1, childLevel: "movers" });
    return true;
  }
  return row.autoRead === 1;
}

async function dueCount(ctx: Ctx, now: number): Promise<number> {
  const db = ctx.db<typeof schema>();
  const rows = await db.select().from(schema.cards);
  return rows.filter(
    (r) => r.state !== "new" && r.dueAt > 0 && r.dueAt <= now,
  ).length;
}

/* ------------------------------------------------------------------ */
/* Behavior-derived FSRS grades (the passive-FSRS rework).             */
/*                                                                     */
/* FSRS is the only scheduler in this product: stability and due_at    */
/* change ONLY through a grade, and a grade now comes from what the    */
/* child observably did — never from a self-rating tap (the buttons    */
/* are gone) and never from a side rule reaching into due_at.          */
/*                                                                     */
/* The derivation follows the researched mapping (see DATA-PLAN):      */
/* grade the FIRST attempt only; a failed first dig attempt (incl.     */
/* retry-correct) is Again; a clean first-try dig pass split into      */
/* Hard/Good by hint use and typo tolerance first, then by a           */
/* stumbled warm-up exercise (it caps the visit at Hard), and by       */
/* time-to-first-response second — latency only ever moves a pass      */
/* between Hard and Good, never turns a pass into a fail, and is       */
/* judged only against the child's OWN recent baseline for the same    */
/* scene type (log scale; >30 s counts as missing — distraction; an    */
/* implausibly fast pass is downgraded one step as a likely guess).    */
/* Easy is never emitted: fast can mean guessing, and a false Easy     */
/* stretches the interval the most. The raw behavior is stored whole   */
/* on the review row so grades can be recomputed if the rule changes.  */
/* ------------------------------------------------------------------ */

type BehaviorIn = {
  guessFirstCorrect?: boolean;
  guessFirstResponseMs?: number | null;
  // The warm-up exercise that opened this visit's practice (a
  // tap-the-word cloze or a build-the-sentence round), when one ran.
  // It never decides the grade — the typed dig's first attempt does —
  // but a warm-up the child stumbled on caps the visit at Hard: the
  // word was still fragile before the dig rescued it.
  warmKind?: "choice" | "build" | null;
  warmFirstCorrect?: boolean;
  digFirstCorrect: boolean;
  digAttempts: number;
  hintUsed: boolean;
  typoTolerated: boolean;
  digFirstResponseMs?: number | null;
};

type DigMode = "cloze" | "dictation" | "sentence";

const LATENCY_BASELINE_MIN = 20; // samples before latency may split Hard/Good
const LATENCY_BASELINE_WINDOW = 50; // most recent samples used
const LATENCY_CAP_MS = 30_000; // beyond this the clock says "distracted", not "slow"

async function latencyBaseline(
  ctx: Ctx,
  mode: DigMode,
): Promise<{ median: number; meanLog: number; sdLog: number } | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.reviews)
    .where(eq(schema.reviews.mode, mode));
  const samples: number[] = [];
  for (const r of rows) {
    if (!r.behaviorJson) continue;
    try {
      const b = JSON.parse(r.behaviorJson) as BehaviorIn;
      const ms = b.digFirstResponseMs;
      if (typeof ms === "number" && ms > 0 && ms <= LATENCY_CAP_MS) {
        samples.push(ms);
      }
    } catch {
      // a malformed legacy row never breaks grading
    }
  }
  const recent = samples.slice(-LATENCY_BASELINE_WINDOW);
  if (recent.length < LATENCY_BASELINE_MIN) return null;
  const logs = recent.map((v) => Math.log(v));
  const meanLog = logs.reduce((a, b) => a + b, 0) / logs.length;
  const variance =
    logs.reduce((a, b) => a + (b - meanLog) * (b - meanLog), 0) / logs.length;
  const sorted = [...recent].sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)] ?? sorted[0] ?? 0;
  return { median: mid, meanLog, sdLog: Math.sqrt(variance) };
}

function deriveGrade(
  behavior: BehaviorIn,
  baseline: { median: number; meanLog: number; sdLog: number } | null,
): "again" | "hard" | "good" {
  // First attempt failed — a later retry succeeding is a new learning
  // event, not a retrieval. Feedback never rewrites this.
  if (!behavior.digFirstCorrect || behavior.digAttempts > 1) return "again";
  // Scaffolded or imperfect passes are weaker evidence than clean ones.
  if (behavior.hintUsed || behavior.typoTolerated) return "hard";
  // A stumbled warm-up caps the visit at Hard: the typed dig passed,
  // but the word needed the warm-up's scaffolding first — it is not
  // yet a clean retrieval. The warm-up can never fail a passed dig,
  // only hold it back from Good.
  if (behavior.warmFirstCorrect === false) return "hard";
  // Latency may only split a clean pass between Hard and Good.
  const ms = behavior.digFirstResponseMs;
  if (typeof ms === "number" && ms > 0 && ms <= LATENCY_CAP_MS && baseline) {
    if (ms < baseline.median * 0.2) return "hard"; // implausibly fast: likely a guess
    if (Math.log(ms) > baseline.meanLog + baseline.sdLog) return "hard"; // slow for THIS child
  }
  return "good";
}

/* ------------------------------------------------------------------ */
/* Streak with free automatic pause days.                              */
/*                                                                     */
/* The streak counts due-cleared days and ONLY due-cleared days (the  */
/* book's rule: 连胜只绑到期清零). A recorded day that had due work    */
/* but was not cleared no longer zeroes the counter on the spot: the  */
/* product hands out free "pause days" automatically — up to two      */
/* consecutive missed days are padded, no currency, no purchase, no   */
/* parent action. A third consecutive miss ends the run. Days never   */
/* recorded (the app was never opened) carry no row and, as before,   */
/* neither extend nor break the run.                                  */
/* ------------------------------------------------------------------ */

type ActivityRow = typeof schema.activity.$inferSelect;

const STREAK_MAX_CONSECUTIVE_PAUSES = 2;

function computeStreakInfo(
  acts: ActivityRow[],
  today: string,
): { streak: number; pausedDays: number; totalPracticeDays: number } {
  const sorted = [...acts].sort((a, b) => b.day.localeCompare(a.day));
  let streak = 0;
  let pausedDays = 0;
  let consecutiveMisses = 0;
  for (const a of sorted) {
    if (a.day > today) continue;
    // Today may still be pending without breaking anything.
    if (a.day === today && a.dueCleared !== 1) continue;
    if (a.dueCleared === 1) {
      streak += 1;
      consecutiveMisses = 0;
      continue;
    }
    if (a.hadDue === 1) {
      if (consecutiveMisses < STREAK_MAX_CONSECUTIVE_PAUSES) {
        consecutiveMisses += 1;
        pausedDays += 1;
        continue;
      }
      break;
    }
  }
  return {
    streak,
    pausedDays,
    totalPracticeDays: acts.filter((a) => a.dueCleared === 1).length,
  };
}

type ReviewRow = typeof schema.reviews.$inferSelect;

/** Whether a review row's FIRST attempt was correct, or null when the
 *  row carries no first-try evidence (legacy recall / speak rows).
 *  Warm-up rows record the pick itself; dig rows carry the visit's
 *  raw behavior, whose digFirstCorrect is the first attempt. */
function firstTryCorrect(r: ReviewRow): boolean | null {
  if (r.mode === "warmup") return r.correct === 1;
  if (r.mode === "cloze" || r.mode === "dictation" || r.mode === "sentence") {
    if (r.behaviorJson) {
      try {
        const b = JSON.parse(r.behaviorJson) as BehaviorIn;
        if (typeof b.digFirstCorrect === "boolean") return b.digFirstCorrect;
      } catch {
        // fall through to the row's final result
      }
    }
    return r.correct === 1;
  }
  return null;
}

/** Longest run of consecutive first-try-correct attempts in a set of
 *  review rows (rows without first-try evidence are skipped, they
 *  neither extend nor break a run). */
function bestCombo(rows: ReviewRow[]): number {
  const sorted = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
  );
  let run = 0;
  let best = 0;
  for (const r of sorted) {
    const ft = firstTryCorrect(r);
    if (ft === null) continue;
    run = ft ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

/** Reconstruct WHEN each card graduated from its review history: the
 *  first moment all four mastery scenes were lit (card scene by a
 *  good/easy grade, each dig scene by a correct dig of that mode).
 *  Mirrors exactly how submitReview lights scenes, so growth and
 *  recap numbers describe real mastery events, not state snapshots. */
function graduationTimes(reviewRows: ReviewRow[]): Map<number, number> {
  const sorted = [...reviewRows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id - b.id,
  );
  const scenes = new Map<
    number,
    { card: boolean; cloze: boolean; dictation: boolean; sentence: boolean }
  >();
  const times = new Map<number, number>();
  for (const r of sorted) {
    if (times.has(r.cardId)) continue;
    const s = scenes.get(r.cardId) ?? {
      card: false,
      cloze: false,
      dictation: false,
      sentence: false,
    };
    if (r.rating === "good" || r.rating === "easy") s.card = true;
    if (r.correct === 1) {
      if (r.mode === "cloze") s.cloze = true;
      else if (r.mode === "dictation") s.dictation = true;
      else if (r.mode === "sentence") s.sentence = true;
    }
    scenes.set(r.cardId, s);
    if (s.card && s.cloze && s.dictation && s.sentence) {
      times.set(r.cardId, r.createdAt.getTime());
    }
  }
  return times;
}

/** Mark today's activity row: due queue cleared (and that there was due work). */
async function markDueCleared(ctx: Ctx, day: string): Promise<void> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.activity)
    .where(eq(schema.activity.day, day));
  const row = rows[0];
  if (row) {
    await db
      .update(schema.activity)
      .set({ dueCleared: 1, hadDue: 1 })
      .where(eq(schema.activity.day, day));
  } else {
    await db.insert(schema.activity).values({
      day,
      hadDue: 1,
      dueCleared: 1,
      rescued: 0,
      rescuedIds: "[]",
    });
  }
}

/* ------------------------------------------------------------------ */
/* The built-in example homework page: a labelled demo so the whole    */
/* flow can be tried before the parent photographs a real page. The    */
/* real path is analyzeHomeworkPhoto below (vision model reads the     */
/* photo directly — no OCR step).                                      */
/* ------------------------------------------------------------------ */

/* The verdict is the heart of the find-words flow. A wrong exercise is
 * not a misspelled word, so every word the reader picks out of a page
 * carries a diagnosis: what observably happened on the page (evidence),
 * what the root cause most likely is (reason), and whether that root
 * cause is lexical enough to deserve a card (decision). childForm —
 * the form the child actually wrote — may be non-null ONLY when the
 * reason is a genuine spelling error; an option letter, a different
 * word the child chose, or a whole sentence the child answered must
 * never be reported as "what the word was written as". */
const verdictSchema = z.object({
  decision: z.enum(["card", "skip"]),
  unit: z.string(),
  unitType: z.enum(["word", "phrase", "pair"]),
  reason: z.enum([
    "spelling",
    "meaning",
    "confusion",
    "collocation",
    "phrase",
    "above_level",
    "at_level",
    "non_lexical",
    "already_known",
    "careless",
  ]),
  priority: z.enum(["high", "medium", "low"]),
  // Which confirmation layer the candidate belongs to. "recommended"
  // is pre-checked for the parent; "optional" sits in a collapsed
  // pool, unchecked by default — recall is widened at candidate
  // stage, strictness lives at the parent's confirmation tap.
  // "none" is for skips (shown only in the folded not-taken list).
  tier: z.enum(["recommended", "optional", "none"]),
  // Where the candidate's claim comes from. "wrong_exercise" is the
  // correction line — it may only be used when the photo actually
  // shows the child's answers (see the photoContent gate below).
  basis: z.enum([
    "wrong_exercise",
    "annotated",
    "key_word",
    "above_new",
    "at_level_core",
    "none",
  ]),
  evidence: z.string(),
  diagnosisZh: z.string(),
  // The one plain front-facing line the parent actually reads: why
  // this word is worth remembering, in human words ("阅读里卡住他的
  // 词" / "Movers 该掌握的核心词，在短文里出现了"). The diagnosis
  // above stays backstage — it decides the learning unit and how the
  // card is made; it is NOT the deliverable shown to parents.
  worthZh: z.string(),
  childForm: z.string().nullable(),
  contrastWith: z.string().nullable(),
});

const exampleWordSchema = z.object({
  word: z.string(),
  level: z.enum(["starters", "movers", "flyers", "beyond"]),
  levelLabel: z.string(),
  ref: z.string(),
  // The original sentence (or exercise line) from the material where
  // this unit appears — the card's birth context, shown to the parent
  // as the candidate's main context line.
  originSentence: z.string(),
  verdict: verdictSchema,
});

/** One homework page, however it was obtained — the built-in example
 *  or a parent's photo read by the vision model. Same shape either
 *  way, so the confirmation flow downstream never cares. */
const homeworkPageSchema = z.object({
  // What the photo actually contains. This gates the whole diagnosis:
  // a questions-only page has no answers, so no correction-type
  // candidate may be produced from it at all.
  photoContent: z.enum([
    "questions_only",
    "with_answers",
    "with_marking",
    "mixed",
    "unclear",
  ]),
  title: z.string(),
  subtitle: z.string(),
  exercises: z.array(
    z.object({
      no: z.string(),
      text: z.string(),
      childAnswer: z.string(),
      mark: z.enum(["right", "wrong"]),
      correction: z.string().nullable(),
    }),
  ),
  words: z.array(exampleWordSchema),
});

function levelNameOf(level: string): string {
  return level === "starters"
    ? "Starters (Pre-A1)"
    : level === "movers"
      ? "Movers (A1)"
      : "Flyers (A2)";
}

const EXAMPLE_PAGE = {
  photoContent: "with_marking" as const,
  title: "Unit 5 · At the Library 在图书馆",
  subtitle: "英语练习册 · 第 32 页",
  exercises: [
    {
      no: "1",
      text: "看图写词：图书馆",
      childAnswer: "libary",
      mark: "wrong" as const,
      correction: "library",
    },
    {
      no: "2",
      text: "选词填空：Can I ＿＿＿ your pen, please?",
      childAnswer: "lend",
      mark: "wrong" as const,
      correction: "borrow",
    },
    {
      no: "3",
      text: "读句子选词：Be ＿＿＿ in the library.",
      childAnswer: "quiet",
      mark: "right" as const,
      correction: null,
    },
    {
      no: "4",
      text: "选词填空：Please ＿＿＿ the book on Friday.",
      childAnswer: "return",
      mark: "right" as const,
      correction: null,
    },
    {
      no: "5",
      text: "看图写词：字典",
      childAnswer: "dictionery",
      mark: "wrong" as const,
      correction: "dictionary",
    },
    {
      no: "6",
      text: "阅读短文：Tom reads a magazine about animals. He must be careful with the books, and finish his homework before dinner.",
      childAnswer: "阅读题全对",
      mark: "right" as const,
      correction: null,
    },
  ],
  words: [
    {
      word: "library",
      level: "movers" as const,
      levelLabel: "Movers · A1",
      ref: "第 1 题 · 看图写词",
      originSentence: "看图写词：图书馆（library）",
      verdict: {
        decision: "card" as const,
        unit: "library",
        unitType: "word" as const,
        reason: "spelling" as const,
        priority: "high" as const,
        tier: "recommended" as const,
        basis: "wrong_exercise" as const,
        evidence: "第 1 题看图写词，孩子写了 libary，正确答案是 library。",
        diagnosisZh:
          "这是真拼写错：中间的 r 漏了，词尾 -ary 没记牢，值得专门记拼写。",
        worthZh: "这个词他写错了，拼写就差一点，值得记牢",
        childForm: "libary",
        contrastWith: null,
      },
    },
    {
      word: "borrow",
      level: "movers" as const,
      levelLabel: "Movers · A1",
      ref: "第 2 题 · Can I ___ your pen?",
      originSentence: "Can I borrow your pen, please?",
      verdict: {
        decision: "card" as const,
        unit: "borrow",
        unitType: "pair" as const,
        reason: "confusion" as const,
        priority: "high" as const,
        tier: "recommended" as const,
        basis: "wrong_exercise" as const,
        evidence: "第 2 题选词填空，孩子选了 lend，正确答案是 borrow。",
        diagnosisZh:
          "不是拼写问题：borrow 没被写错，是方向反了——东西进我手是 borrow，出我手才是 lend，词义方向没吃透。",
        worthZh: "借东西时天天要用，和 lend 的方向最容易搞反",
        childForm: null,
        contrastWith: "lend",
      },
    },
    {
      word: "dictionary",
      level: "flyers" as const,
      levelLabel: "Flyers · A2",
      ref: "第 5 题 · 看图写词",
      originSentence: "看图写词：字典（dictionary）",
      verdict: {
        decision: "card" as const,
        unit: "dictionary",
        unitType: "word" as const,
        reason: "spelling" as const,
        priority: "high" as const,
        tier: "recommended" as const,
        basis: "wrong_exercise" as const,
        evidence: "第 5 题看图写词，孩子写了 dictionery，正确答案是 dictionary。",
        diagnosisZh: "真拼写错：词尾 -ary 写成了 -ery，和 library 一样的拼写尾巴。",
        worthZh: "这个词他写错了，词尾总写错，值得记牢",
        childForm: "dictionery",
        contrastWith: null,
      },
    },
    {
      word: "quiet",
      level: "movers" as const,
      levelLabel: "Movers · A1",
      ref: "第 3 题 · Be ___ in the library.",
      originSentence: "Be quiet in the library.",
      verdict: {
        decision: "card" as const,
        unit: "quiet",
        unitType: "word" as const,
        reason: "at_level" as const,
        priority: "low" as const,
        tier: "optional" as const,
        basis: "at_level_core" as const,
        evidence: "第 3 题 Be ___ in the library，孩子选对了 quiet，这道题批改是 ✓；这句话本身就是现成的出生句。",
        diagnosisZh:
          "不是改错：这题他答对了。quiet 是 Movers 当前水平的核心词，又是图书馆场景的承重词，材料里有现成句子，收进可选池巩固——答对一次不等于能主动用出来，家长觉得不用可不勾。",
        worthZh: "Movers 该掌握的核心词，在这句话里出现了",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "homework",
      level: "movers" as const,
      levelLabel: "Movers · A1",
      ref: "第 6 题 · 阅读短文里的词",
      originSentence: "He must finish his homework before dinner.",
      verdict: {
        decision: "card" as const,
        unit: "homework",
        unitType: "word" as const,
        reason: "at_level" as const,
        priority: "low" as const,
        tier: "optional" as const,
        basis: "at_level_core" as const,
        evidence: "第 6 题阅读短文里有 finish his homework before dinner，阅读题全对；这句话就是现成的出生句。",
        diagnosisZh:
          "不是改错：阅读里顺利碰到了。homework 是 Movers 课内核心词、天天要用，材料里有现成句子，收进可选池巩固即可，不必默认勾。",
        worthZh: "Movers 该掌握的核心词，在短文里出现了",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "shelf",
      level: "flyers" as const,
      levelLabel: "Flyers · A2",
      ref: "第 1 题 · 图中书架旁标注的词",
      originSentence: "（第 1 题图里，书架旁标注的词）",
      verdict: {
        decision: "card" as const,
        unit: "shelf",
        unitType: "word" as const,
        reason: "above_level" as const,
        priority: "medium" as const,
        tier: "optional" as const,
        basis: "above_new" as const,
        evidence: "第 1 题图里书架旁标注了 shelf，这一页没有考它的题。",
        diagnosisZh:
          "Flyers 词，高于孩子现在的 Movers 水平，是看图和阅读会碰到的关键新词，值得先认识。",
        worthZh: "高一级的新词，看图和阅读还会再碰到",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "return",
      level: "flyers" as const,
      levelLabel: "Flyers · A2",
      ref: "第 4 题 · Please ___ the book on Friday.",
      originSentence: "Please return the book on Friday.",
      verdict: {
        decision: "card" as const,
        unit: "return",
        unitType: "word" as const,
        reason: "above_level" as const,
        priority: "low" as const,
        tier: "optional" as const,
        basis: "above_new" as const,
        evidence: "第 4 题选词填空，孩子从选项里选对了 return。",
        diagnosisZh:
          "相遇检验降级：它在第 4 题被选对过，但那是从选项里认出来，离自己会用还远；又是超纲词，低优先收下。",
        worthZh: "高一级的新词，还书这类场景常要用",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "magazine",
      level: "flyers" as const,
      levelLabel: "Flyers · A2",
      ref: "第 6 题 · 阅读短文里的词",
      originSentence: "Tom reads a magazine about animals.",
      verdict: {
        decision: "card" as const,
        unit: "magazine",
        unitType: "word" as const,
        reason: "above_level" as const,
        priority: "medium" as const,
        tier: "recommended" as const,
        basis: "key_word" as const,
        evidence: "第 6 题阅读短文第一句就有 magazine（Tom reads a magazine）。",
        diagnosisZh: "Flyers 超纲词，是读懂这段短文的关键新词，值得记。",
        worthZh: "读懂这段短文的关键新词",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "careful",
      level: "flyers" as const,
      levelLabel: "Flyers · A2",
      ref: "第 6 题 · 阅读短文里的词",
      originSentence: "He must be careful with the books.",
      verdict: {
        decision: "card" as const,
        unit: "careful",
        unitType: "word" as const,
        reason: "above_level" as const,
        priority: "medium" as const,
        tier: "optional" as const,
        basis: "above_new" as const,
        evidence: "第 6 题阅读短文里有 be careful with the books。",
        diagnosisZh: "Flyers 超纲词，还带着常用搭配 be careful with，一起记最划算。",
        worthZh: "高一级的新词，还带着常用搭配 be careful with",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "story",
      level: "starters" as const,
      levelLabel: "Starters · Pre-A1",
      ref: "第 3 题 · 同题选项里的词",
      originSentence: "（第 3 题选项里的词）",
      verdict: {
        decision: "skip" as const,
        unit: "story",
        unitType: "word" as const,
        reason: "already_known" as const,
        priority: "low" as const,
        tier: "none" as const,
        basis: "none" as const,
        evidence: "只在第 3 题的选项里出现，孩子没有在它上面出错。",
        diagnosisZh: "Starters 词，低于孩子现在的水平，也没有出错证据，不收。",
        worthZh: "",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "read",
      level: "starters" as const,
      levelLabel: "Starters · Pre-A1",
      ref: "第 6 题 · 阅读短文里的词",
      originSentence: "Tom reads a magazine about animals.",
      verdict: {
        decision: "skip" as const,
        unit: "read",
        unitType: "word" as const,
        reason: "already_known" as const,
        priority: "low" as const,
        tier: "none" as const,
        basis: "none" as const,
        evidence: "第 6 题短文里有 reads，阅读题全对。",
        diagnosisZh: "基础词，孩子已经在阅读里用对了，不收。",
        worthZh: "",
        childForm: null,
        contrastWith: null,
      },
    },
    {
      word: "page",
      level: "starters" as const,
      levelLabel: "Starters · Pre-A1",
      ref: "第 5 题 · 题目旁的词",
      originSentence: "（第 5 题题目旁的词）",
      verdict: {
        decision: "skip" as const,
        unit: "page",
        unitType: "word" as const,
        reason: "already_known" as const,
        priority: "low" as const,
        tier: "none" as const,
        basis: "none" as const,
        evidence: "只在题目说明旁出现，没有题目考它。",
        diagnosisZh: "基础词，没有出错或超纲的理由，不收。",
        worthZh: "",
        childForm: null,
        contrastWith: null,
      },
    },
  ],
};

/* ------------------------------------------------------------------ */
/* Card content generation via ctx.inference                           */
/* ------------------------------------------------------------------ */

const generatedCardSchema = z.object({
  word: z.string(),
  phonetic: z.string(),
  pos: z.string(),
  meaningZh: z.string(),
  collocations: z.array(collocationSchema).min(1).max(2),
  examples: z.array(exampleSchema).min(1).max(2),
  contrastWord: z.string().nullable(),
  contrastNoteZh: z.string().nullable(),
});
const generatedBatchSchema = z.object({
  cards: z.array(generatedCardSchema).min(1),
});

type Candidate = {
  word: string;
  sourceType: "spelling" | "meaning" | "above" | "manual";
  sourceRef: string;
  wordLevel: string;
  hint: string;
};

async function generateAndInsert(
  ctx: Ctx,
  candidates: Candidate[],
  childLevel: string,
): Promise<{ created: number; skipped: string[] }> {
  const db = ctx.db<typeof schema>();
  const existing = await db.select().from(schema.cards);
  const existingWords = new Set(existing.map((r) => r.word.toLowerCase()));
  const fresh = candidates.filter(
    (c) => !existingWords.has(c.word.trim().toLowerCase()),
  );
  const skipped = candidates
    .filter((c) => existingWords.has(c.word.trim().toLowerCase()))
    .map((c) => c.word);
  if (fresh.length === 0) return { created: 0, skipped };

  const levelName = levelNameOf(childLevel);
  const lines = fresh
    .map(
      (c) =>
        `- ${c.word}（级别 ${c.wordLevel || "未标注"}；出处：${c.sourceRef || "家长手动添加"}${c.hint ? `；备注：${c.hint}` : ""}）`,
    )
    .join("\n");

  const result = await ctx.inference.complete(
    `为一名中国小学生（剑桥少儿英语约 ${levelName} 水平）制作英语单词闪卡。下面的学习单位全部来自对孩子作业页的错因诊断（备注里写了卷面证据和诊断）：\n${lines}\n\n每个学习单位生成一张卡，word 字段就填这个学习单位本身（可以是单个词，也可以是短语，如 last name）：英式 IPA 音标（短语给整个短语的音标）；英文词性缩写（如 verb / noun / adjective；短语写 phrase）；简洁的中文意思；固定搭配只给 1–2 个最常用的（短语+中文，宁少勿滥，不要凑数）；例句只给 1–2 个，第一句最重要——那是孩子第一次见到它的场景，要最贴近孩子的生活，目标单位在句中出现（原形或自然变形均可），每句配中文翻译。\n卡要对着诊断里的缺口做：如果诊断是拼写错，例句正常即可，卡的价值在把正确拼写练熟；如果诊断是短语概念（如把 last name 答成全名），例句和对比要把这个短语和它混淆的概念（如 full name）放在一起对照着用；如果诊断是词义没吃透，例句要落在孩子出错的那个意思/场景上，不要换成别的义项。\n如果某个词有一个中国孩子特别容易混淆的近义词（如 borrow/lend、say/tell、look/see/watch、big/large），或备注里已经点名了易混对比（如「易混对比：lend」），把那个词写进 contrastWord，并在 contrastNoteZh 里用中文讲清区别——重点讲使用方向或场景的不同，并在说明里各放一个简短对比例句；没有公认易混词的词，contrastWord 和 contrastNoteZh 都填 null。`,
    {
      system:
        "You create precise, kid-friendly English flashcards for Chinese primary-school children. Content must be accurate and age-appropriate.",
      schema: generatedBatchSchema,
    },
  );

  const byWord = new Map(
    result.cards.map((c) => [c.word.trim().toLowerCase(), c]),
  );
  let created = 0;
  const missed: string[] = [];
  for (const cand of fresh) {
    const gen = byWord.get(cand.word.trim().toLowerCase());
    if (!gen) {
      missed.push(cand.word);
      continue;
    }
    await db.insert(schema.cards).values({
      word: gen.word.trim(),
      phonetic: gen.phonetic,
      pos: gen.pos,
      meaningZh: gen.meaningZh,
      collocationsJson: JSON.stringify(gen.collocations),
      examplesJson: JSON.stringify(gen.examples),
      contrastWord: gen.contrastWord,
      contrastNoteZh: gen.contrastNoteZh,
      sourceType: cand.sourceType,
      sourceRef: cand.sourceRef,
      wordLevel: cand.wordLevel,
      state: "new",
      stability: 0,
      dueAt: 0,
      reps: 0,
      lapses: 0,
      sceneCard: 0,
      sceneCloze: 0,
      sceneDictation: 0,
      sceneSentence: 0,
    });
    created += 1;
  }
  return { created, skipped: [...skipped, ...missed] };
}

/* ------------------------------------------------------------------ */
/* Product speech: the artifact's own high-quality pronunciation.      */
/* Synthesized once per (accent, text) via the privileged tts CLI and  */
/* cached as an owned blob; every device then plays the same clip.     */
/* ------------------------------------------------------------------ */

const SPEECH_VOICES = {
  // British, young and clear — matches the British IPA printed on cards.
  gb: "avocado_v2:paloma",
  // Aria — American, warm and friendly.
  us: "avocado_v2:MAI_01",
} as const;
type Accent = keyof typeof SPEECH_VOICES;

async function speechCacheKey(accent: Accent, text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${accent}|${text}`),
  );
  const hex = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `speech/${accent}-${hex}.mp3`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */


/* Server-side enforcement of the two rules the product promises, so
 * they hold even when the vision model misbehaves on a real photo:
 * (1) a questions-only (or unreadable) photo yields ZERO correction-
 * line candidates — any card claiming a wrong-exercise basis is
 * demoted to a skip before the client ever sees it; (2) the tier
 * caps (recommended <= 8, optional <= 10, cards total <= 18) hold.
 * The regression probes call the raw prompt directly, so this helper
 * never masks a prompt failure in evaluation. */
type HomeworkPageOut = z.infer<typeof homeworkPageSchema>;

function applyPhotoGate(page: HomeworkPageOut): HomeworkPageOut {
  const noAnswers =
    page.photoContent === "questions_only" || page.photoContent === "unclear";
  let rec = 0;
  let opt = 0;
  const words = page.words.map((w) => {
    const v = w.verdict;
    if (v.decision !== "card") return w;
    if (noAnswers && v.basis === "wrong_exercise") {
      return {
        ...w,
        verdict: {
          ...v,
          decision: "skip" as const,
          reason: "non_lexical" as const,
          tier: "none" as const,
          basis: "none" as const,
          childForm: null,
          diagnosisZh: v.diagnosisZh.startsWith("还没看到作答")
            ? v.diagnosisZh
            : `还没看到作答：${v.diagnosisZh}`,
        },
      };
    }
    if (noAnswers && !v.diagnosisZh.startsWith("还没看到作答")) {
      return {
        ...w,
        verdict: {
          ...v,
          diagnosisZh: `还没看到作答：${v.diagnosisZh}`,
        },
      };
    }
    return w;
  });
  const capped = words.map((w) => {
    const v = w.verdict;
    if (v.decision !== "card") return w;
    if (v.tier === "recommended") {
      rec += 1;
      if (rec > 8 || rec + opt > 18) {
        return { ...w, verdict: { ...v, tier: "optional" as const } };
      }
      return w;
    }
    if (v.tier === "optional") {
      opt += 1;
      if (opt > 10 || rec + opt > 18) {
        return {
          ...w,
          verdict: {
            ...v,
            decision: "skip" as const,
            reason: "already_known" as const,
            tier: "none" as const,
            basis: "none" as const,
          },
        };
      }
      return w;
    }
    return w;
  });
  return { ...page, words: capped };
}

/* Merge the per-page reads of one multi-photo batch into a single
 * page result. Words are deduped by learning unit across pages (the
 * strongest verdict wins: a card beats a skip, recommended beats
 * optional, a spelling verdict with the child's actual form beats a
 * plain one), exercises concatenate in page order, and the merged
 * page goes through applyPhotoGate once more so the tier caps hold
 * for the batch as a whole, not just per page. photoContent is the
 * batch-level truth: the correction line stays closed only when NO
 * page showed answers. */
function mergeHomeworkPages(pages: HomeworkPageOut[]): HomeworkPageOut {
  const contents = pages.map((p) => p.photoContent);
  const anyAnswers = contents.some(
    (c) => c === "with_answers" || c === "with_marking" || c === "mixed",
  );
  const anyMarking = contents.some((c) => c === "with_marking");
  const anyBlank = contents.some(
    (c) => c === "questions_only" || c === "unclear",
  );
  let photoContent: HomeworkPageOut["photoContent"];
  if (!anyAnswers) {
    photoContent = contents.includes("questions_only")
      ? "questions_only"
      : "unclear";
  } else if (anyBlank) {
    photoContent = "mixed";
  } else if (anyMarking) {
    photoContent = "with_marking";
  } else {
    photoContent = "with_answers";
  }

  const score = (w: HomeworkPageOut["words"][number]): number => {
    const v = w.verdict;
    let s = v.decision === "card" ? 100 : 0;
    s += v.tier === "recommended" ? 30 : v.tier === "optional" ? 15 : 0;
    s += v.priority === "high" ? 3 : v.priority === "medium" ? 2 : 1;
    if (v.basis === "wrong_exercise") s += 5;
    if (v.childForm) s += 2;
    return s;
  };
  const byUnit = new Map<string, HomeworkPageOut["words"][number]>();
  for (const p of pages) {
    for (const w of p.words) {
      const k =
        w.verdict.unit.trim().toLowerCase() || w.word.trim().toLowerCase();
      const prev = byUnit.get(k);
      if (!prev || score(w) > score(prev)) byUnit.set(k, w);
    }
  }

  const first = pages[0];
  return applyPhotoGate({
    photoContent,
    title: first?.title ?? "作业页",
    subtitle: first?.subtitle ?? "拍照识别",
    exercises: pages.flatMap((p) => p.exercises),
    words: [...byUnit.values()],
  });
}


/* Read ONE photographed homework page with the vision model (no OCR
 * step): the full diagnosis-first prompt — photo-content gate first,
 * then root-cause diagnosis backstage, then tiered candidates. Shared
 * by analyzeHomeworkPhoto (legacy one-shot path) and processFindJob
 * (the resumable server-side job path). */
async function readHomeworkPage(
  ctx: Ctx,
  image: { imageBase64: string; mimeType: "image/jpeg" | "image/png" },
  level: "starters" | "movers" | "flyers",
): Promise<HomeworkPageOut> {
  const levelName = levelNameOf(level);
  const result = await ctx.inference.complete(
  `这是一张中国小学生英语作业页的照片。你的任务只有一个：从这一页材料里找出孩子值得记住的词。错因诊断只是你挑词的后台手段，不是交付物——交付物是词本身。

【第零步：先判照片成分 photoContent——这道闸门决定后面所有判断】
先只回答一个问题：这张照片里到底有没有孩子的作答？
- questions_only：只有印好的题目和材料，完全看不到孩子的手写答案、勾选或填涂。
- with_answers：能看到孩子的作答（手写/勾选/填涂），但没有老师的批改痕迹。
- with_marking：既有作答，又有老师的批改（红勾红叉、订正、扣分）。
- mixed：一页里一部分题有作答、另一部分完全空白。
- unclear：照片太糊或角度问题，看不清到底有没有作答。
把结论填进 photoContent 字段，一字不差用上面五个值之一。

【闸门：没拍到作答，就不许给改错】
- photoContent = questions_only 时，改错线彻底关闭：任何候选都不许声称孩子写错了、选错了、答错了或被老师订正了；basis 不许填 wrong_exercise；reason 不许填 spelling / meaning / confusion / collocation / phrase；childForm 一律 null；mark 无法判断对错时填 right、correction 填 null，childAnswer 写「未作答」。这一页只能从材料本身挑词（见【从材料挑词】），每个 card 候选的 diagnosisZh 必须以「还没看到作答：」开头，worthZh 也只许讲这个词本身为什么值得学，不许提他错了。
- photoContent = unclear 时，按 questions_only 同等处理，并在每个候选 diagnosisZh 开头写明「还没看到作答（照片看不清有没有作答）：」。
- photoContent = mixed 时，逐题执行：有作答的题可以走诊断线；没作答的题按 questions_only 处理——那部分材料里挑出的候选，diagnosisZh 同样以「还没看到作答：」开头，basis 不许填 wrong_exercise。
- photoContent = with_answers 时，可以根据作答本身诊断，但没有老师批改佐证，措辞留余地（「看起来」「大概率」）。
- photoContent = with_marking 时，诊断线全开。

【第一步：读页】
1. title：优先用页面上能看出的单元/课文名；看不出写「作业页」。
2. subtitle：能看出的来源信息；看不出写「拍照识别」。
3. exercises：按顺序列出每一道题：no 题号；text 题目原文（填空用 ＿＿＿）；childAnswer 孩子写下的答案（没作答写「未作答」，看不清写「看不清」）；mark 与 correction 按上面闸门规则填。

【第二步：后台诊断——只在闸门允许的范围内做】
铁律：错题 ≠ 写错单词。逐道错题先判根因类别（只写进 reason/diagnosisZh，不许变成给家长看的报告）：
- spelling 拼写：孩子要写的就是这个词，但拼错了（如 library 写成 libary）。
- meaning 词义 / confusion 易混 / collocation 搭配 / phrase 短语概念：断点在词汇层面的其余四类（如 borrow/lend 方向反、问 last name 答了全名——错的是短语概念不是 last 的拼写）。
- non_lexical 非词汇：审题、看图对信息、推理、对话答语、语法句型——这类错题的关键词绝不因为出现在错题里就收卡。
- careless 粗心：别处用对过、这次像手误。
childForm 硬禁令：只有 reason = spelling 才填孩子真写错的拼写；选项字母、孩子选的另一个词、整句回答一律不许填。
【相遇检验】同词在这一页别处被用对过，就降 priority 或改 skip，diagnosisZh 写明在第几题答对过。
【涂改看最终稿】划掉重写的以最后稿为准；被划掉的一笔不是答案，不许当 childForm；最终稿写对不得判拼写错；只被轻扣（如 -0.5）时措辞留余地。

【阅读题承重词——回退规则，仅当照片含作答时适用】
阅读/信息判断题答错时（仅 with_answers / with_marking，或 mixed 中已作答的题），不停在「判断错」：回材料里找承重超纲词——同时满足 (1) 超出孩子当前水平（${levelName}）；(2) 这道题的判断恰好压在这个词上。每题至多 1–2 个；体裁词（notice/email）不是承重词；找不到就按 non_lexical 处理。承重词：decision = card，reason = above_level，basis = key_word，tier = recommended。
试卷自带中文注释的词（如 patient（有耐心的））是出卷人标出的超纲强信号：它若是某道题材料里的理解关键，按承重词收（basis = annotated、tier = recommended）；有注释但判断不压在它身上的，不收或放可选。

【从材料挑词——任何照片成分都适用】
不依赖作答、只看材料本身就能挑的词，三条来源：
(a) 超纲关键新词：高于 ${levelName}、又是读懂这段材料的关键（basis = above_new 或 key_word）。
(b) 卷内注释词：试卷自己加了中文注释的词（basis = annotated）。
(c) 当前水平核心词（basis = at_level_core，reason = at_level）：级别恰好等于孩子当前水平（${level}）的词，同时满足三条才收——在真实材料里承重（撑着一句话/一段话的理解）、属课内核心（高频、主题核心）、材料里有它现成的原句可作出生句。已答对也可收，但只许进可选层，worthZh/diagnosisZh 必须明说是巩固、不是改错（如「Movers 该掌握的核心词，在短文里出现了」）。
每个候选必须在材料里有现成原句（填进 originSentence，照抄材料原句；看图词等没有句子的，写那道题的题干）。功能词、专有名词、人名地名、数字、一次性情境词一律不收。

【第三步：分层——推荐层与可选层】
每个 card 候选必须定 tier 和 basis：
- tier = recommended（系统会直接做成卡）：证据明确——闸门允许时、错因在词汇层面的错题词（basis = wrong_exercise）；承重超纲词（basis = key_word）；注释且承重的词（basis = annotated）。
- tier = optional（家长在结果页一键补卡）：值得记但弱一档——当前水平核心词（basis = at_level_core）；超纲但非承重的词（basis = above_new）；证据不够硬、拿不准的词。
- decision = skip 的词：tier = none，basis = none。
封顶：recommended 最多 8 个，optional 最多 10 个，两层合计最多 18 个；words 总数（含 skip）最多 18 个。超了就按重要性往下砍，不许整页泛滥。skip 只列你在错题里认真考虑过又放弃的词，普通答对词不用列。

【每个词要填的字段】
- word 锚点词（正确拼写、原形、小写，专有名词除外）；level / levelLabel 按剑桥少儿词表；ref 简短出处。
- originSentence：这个单位在材料里的原句，照抄，不要改写、不要编造。
- verdict.unit / unitType：真正要学的单位——可以是词、短语（如 last name，unitType = phrase）或易混对主词（如 borrow，unitType = pair、contrastWith = lend）。
- verdict.reason / priority / tier / basis：按上面规则。
- verdict.evidence：一行事实（第几题、材料里哪句），只写看得见的，不写推测。
- verdict.diagnosisZh：一到两句后台诊断（错因是什么、为什么收或不收）；非拼写错因必须明说「不是拼写问题」。questions_only / unclear 的候选按闸门要求以「还没看到作答：」开头。
- verdict.worthZh：一句人话，给家长看的唯一理由——只讲这个词为什么值得记，不讲分类、不讲报告话。例如：「阅读里卡住他的词」「Movers 该掌握的核心词，在短文里出现了」「这个词他写错了，拼写就差一点」。spelling 时才许提写错；其余情况不许出现「写错了」。
- verdict.childForm / contrastWith：按硬禁令填。

【校准例子】
1. "I can type ＿＿＿." 选配图选错了 → type 没被写错：skip / non_lexical / none / none，childForm null。
2. 问 "What's your last name?" 答了全名 → card，unit = "last name"，phrase，reason = phrase，contrastWith = "full name"，basis = wrong_exercise，worthZh 讲清「问的是姓，这个短语总和 full name 搞混」。
3. "Welcome." 后答语选错 → welcome 没被写错：skip / non_lexical，childForm null（除非有证据表明他不懂 welcome 的词义）。
4. 一整页只有题目和阅读材料、一个手写字都没有 → photoContent = questions_only；passengers、performance 这类词即使值得学，也只能以 basis = key_word / above_new、diagnosisZh 以「还没看到作答：」开头的方式出现，绝不许写成他做错了某题。

【纪律】
只收页面上真实出现的词，不编造词、题目或答案。照片里没有英文作业内容时，exercises 和 words 都给空数组。`,
  {
    system:
      "You are an experienced Chinese primary-school English teacher. You read photographs of children's English homework pages faithfully — never invent words, exercises, or answers that are not visible — and then you diagnose, for every wrong exercise, WHY it went wrong before deciding which words or phrases are actually worth memorising. A wrong exercise is not a misspelled word.",
    images: [
      {
        dataBase64: image.imageBase64,
        mimeType: image.mimeType,
        caption: "孩子的一页英语作业（照片）",
      },
    ],
    schema: homeworkPageSchema,
    // Dense exam spreads take a while to read and diagnose; the
    // earlier 120s cap timed out on a real two-page spread.
    timeout_secs: 240,
  },
  );
  return applyPhotoGate(result);
}

/* ------------------------------------------------------------------ */
/* Find jobs: resumable server-side photo reading.                     */
/*                                                                     */
/* The parent approved temporary server-side photo storage           */
/* (2026-11-11: 「可以临时存，识别完立刻删」) so a read no longer dies */
/* with the page. startFindJob stores the pages (ctx.blobs under     */
/* findjob/<jobId>/page-<i>.jpg + find_job_pages rows), creates a    */
/* queued job and returns at once; a spawned background task (with   */
/* the polling client as fallback) drives processFindJob, which      */
/* reads the pages with the same prompt + gate as analyzeHomework-   */
/* Photo, merges them, makes the recommended cards, stores ONLY the  */
/* word result, and deletes every photo copy the moment the job      */
/* reaches done or failed. Jobs stuck unfinished for 30 minutes are  */
/* swept (photos deleted, status failed) lazily by any job action.   */
/* ------------------------------------------------------------------ */

const FIND_JOB_STALE_MS = 15 * 60_000;
const FIND_JOB_EXPIRE_MS = 30 * 60_000;

const findCandidateSchema = z.object({
  word: z.string(),
  sourceType: z.enum(["spelling", "meaning", "above", "manual"]),
  sourceRef: z.string(),
  wordLevel: z.string(),
  hint: z.string(),
  originSentence: z.string(),
  worthZh: z.string(),
  evidence: z.string(),
  childForm: z.string().nullable(),
  isPhrase: z.boolean(),
  contrastWith: z.string().nullable(),
  tier: z.enum(["recommended", "optional"]),
  basis: z.string(),
});
type FindCandidate = z.infer<typeof findCandidateSchema>;

const findResultSchema = z.object({
  createdWords: z.array(z.string()),
  created: z.number(),
  all: z.array(findCandidateSchema),
  optional: z.array(findCandidateSchema),
  questionsOnly: z.boolean(),
  skippedCount: z.number(),
  failedPages: z.number(),
});
type FindResult = z.infer<typeof findResultSchema>;

const findJobOutSchema = z.object({
  id: z.string(),
  status: z.enum(["queued", "reading", "making", "done", "failed"]),
  pageCount: z.number(),
  createdAt: z.number(),
  photosDeleted: z.boolean(),
  error: z.string().nullable(),
  result: findResultSchema.nullable(),
});
type FindJobRow = typeof schema.findJobs.$inferSelect;

const REASON_LABEL_SERVER: Record<
  HomeworkPageOut["words"][number]["verdict"]["reason"],
  string
> = {
  spelling: "拼写",
  meaning: "词义",
  confusion: "易混",
  collocation: "搭配",
  phrase: "短语概念",
  above_level: "超纲新词",
  at_level: "课内核心",
  non_lexical: "不是词汇问题",
  already_known: "已经会了",
  careless: "粗心",
};

/** Build the client-shaped candidate lists from one merged page —
 *  the server twin of the find screen's former toCandidate logic, so
 *  a job result can be rendered exactly like the old in-page result. */
function candidatesFromPage(page: HomeworkPageOut): {
  recommended: FindCandidate[];
  optional: FindCandidate[];
  questionsOnly: boolean;
  skippedCount: number;
} {
  const toCandidate = (
    w: HomeworkPageOut["words"][number],
  ): FindCandidate => {
    const v = w.verdict;
    const hintParts = [
      `学习单位：${v.unit}（${v.unitType === "phrase" ? "短语" : v.unitType === "pair" ? "易混对主词" : "单词"}）`,
      `错因类型：${REASON_LABEL_SERVER[v.reason]}`,
      `卷面证据：${v.evidence}`,
      `诊断：${v.diagnosisZh}`,
    ];
    if (v.reason === "spelling" && v.childForm) {
      hintParts.push(`孩子把这个词写成了 ${v.childForm}（拼写错误）`);
    }
    if (v.contrastWith) hintParts.push(`易混对比：${v.contrastWith}`);
    return {
      word: v.unit,
      sourceType:
        v.reason === "spelling"
          ? "spelling"
          : v.reason === "above_level"
            ? "above"
            : "meaning",
      sourceRef: w.ref,
      wordLevel: w.levelLabel,
      hint: hintParts.join("；"),
      originSentence: w.originSentence,
      worthZh: v.worthZh,
      evidence: v.evidence,
      childForm: v.reason === "spelling" ? v.childForm : null,
      isPhrase: v.unitType === "phrase",
      contrastWith: v.contrastWith,
      tier: v.tier === "optional" ? "optional" : "recommended",
      basis: v.basis,
    };
  };
  const cards = page.words.filter((w) => w.verdict.decision === "card");
  const seen = new Set<string>();
  const deduped = cards.filter((w) => {
    const k = w.verdict.unit.trim().toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    recommended: deduped
      .filter((w) => w.verdict.tier !== "optional")
      .map(toCandidate),
    optional: deduped
      .filter((w) => w.verdict.tier === "optional")
      .map(toCandidate),
    questionsOnly:
      page.photoContent === "questions_only" ||
      page.photoContent === "unclear",
    skippedCount: page.words.filter((w) => w.verdict.decision === "skip")
      .length,
  };
}

type FindJobAnalysis = {
  pages: (HomeworkPageOut | null)[];
  attempted: boolean[];
  failedPages: number;
  merged: {
    recommended: FindCandidate[];
    optional: FindCandidate[];
    questionsOnly: boolean;
    skippedCount: number;
  } | null;
};

function parseJsonOr<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function loadFindJob(
  ctx: Ctx,
  jobId: string,
): Promise<FindJobRow | null> {
  const db = ctx.db<typeof schema>();
  const rows = await db
    .select()
    .from(schema.findJobs)
    .where(eq(schema.findJobs.id, jobId));
  return rows[0] ?? null;
}

/** Delete BOTH temporary photo copies (blobs + page rows). Never
 *  throws: cleanup must not be able to sink the job it cleans up for. */
async function deleteFindJobPhotos(ctx: Ctx, job: FindJobRow): Promise<void> {
  const keys = parseJsonArray<string>(job.photoKeysJson, []);
  for (const k of keys) {
    try {
      await ctx.blobs.delete(k);
    } catch {
      /* already gone */
    }
  }
  try {
    const db = ctx.db<typeof schema>();
    await db
      .delete(schema.findJobPages)
      .where(eq(schema.findJobPages.jobId, job.id));
  } catch {
    /* already gone */
  }
}

async function failFindJob(
  ctx: Ctx,
  job: FindJobRow,
  error: string,
): Promise<void> {
  await deleteFindJobPhotos(ctx, job);
  const db = ctx.db<typeof schema>();
  await db
    .update(schema.findJobs)
    .set({
      status: "failed",
      error: error.slice(0, 300),
      photosDeleted: 1,
      updatedAtMs: Date.now(),
    })
    .where(eq(schema.findJobs.id, job.id));
}

/** Lazy expiry sweep: a job stuck unfinished for over 30 minutes has
 *  its photos deleted and is marked failed — run at the top of every
 *  job action so no cron is needed for the promise to hold. */
async function sweepExpiredFindJobs(ctx: Ctx): Promise<void> {
  const db = ctx.db<typeof schema>();
  const now = Date.now();
  const rows = await db.select().from(schema.findJobs);
  for (const j of rows) {
    if (
      (j.status === "queued" ||
        j.status === "reading" ||
        j.status === "making") &&
      now - j.updatedAtMs > FIND_JOB_EXPIRE_MS
    ) {
      await failFindJob(ctx, j, "expired");
    }
  }
}

function findJobToOut(job: FindJobRow): z.infer<typeof findJobOutSchema> {
  return {
    id: job.id,
    status: job.status,
    pageCount: job.pageCount,
    createdAt: job.createdAtMs,
    photosDeleted: job.photosDeleted === 1,
    error: job.error,
    result: parseJsonOr<FindResult | null>(job.resultJson, null),
  };
}

/* The incentive layer's response shape (see getIncentives). Every
 * number in it is derived from cards / reviews / activity rows — real
 * learning records only. */
const periodStatsSchema = z.object({
  reviews: z.number(),
  digFirstTotal: z.number(),
  digFirstCorrect: z.number(),
  newCards: z.number(),
  graduated: z.number(),
  rescued: z.number(),
  practiceDays: z.number(),
});
const incentivesResponse = z.object({
  quests: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string(),
      progress: z.number(),
      target: z.number(),
      done: z.boolean(),
    }),
  ),
  badges: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      desc: z.string(),
      value: z.number(),
      tier: z.number(),
      tiers: z.array(z.number()),
      nextTarget: z.number().nullable(),
    }),
  ),
  progress: z.object({
    graduatedTotal: z.number(),
    graduatedThisWeek: z.number(),
    graduatedThisMonth: z.number(),
    longTermCount: z.number(),
    totalPracticeDays: z.number(),
    totalCards: z.number(),
  }),
  weekly: z.object({
    thisWeek: periodStatsSchema,
    lastWeek: periodStatsSchema,
  }),
  monthly: periodStatsSchema.extend({
    month: z.string(),
    graduatedTotal: z.number(),
  }),
  streak: z.object({
    current: z.number(),
    pausedDays: z.number(),
    totalPracticeDays: z.number(),
  }),
});

export const Actions = {
  getSpeech: defineAction({
    description:
      "Returns a playable URL for the product's own high-quality pronunciation of one English word or sentence (British or American voice), synthesized once and then cached.",
    request: z.object({
      text: z.string().min(1).max(300),
      accent: z.enum(["gb", "us"]).default("gb"),
    }),
    response: z.object({ url: z.string() }),
    privileged: [privileged.synthesizeSpeech],
    async handler(ctx, args) {
      const text = args.text.trim().replace(/\s+/g, " ");
      const key = await speechCacheKey(args.accent, text);
      const existing = await ctx.blobs.head(key);
      if (!existing) {
        const { audioBase64 } = await ctx.executePrivileged(
          privileged.synthesizeSpeech,
          { text, voiceId: SPEECH_VOICES[args.accent] },
        );
        await ctx.blobs.put(key, base64ToBytes(audioBase64), {
          contentType: "audio/mpeg",
        });
      }
      const url = await ctx.blobs.getUrl(key);
      return { url };
    },
  }),

  analyzeHomeworkPhoto: defineAction({
    description:
      "Reads one batch of photographed homework pages (1–6 photos of the same assignment, e.g. a multi-page exam) with the vision model (no OCR step) and returns the words worth remembering from them, in two tiers: recommended (the client turns these into flashcards immediately, no confirmation step) and an optional pool (one-tap add on the result page). Each page is read with the same per-page prompt and gated separately, then the reads are merged and deduped by learning unit and the tier caps are re-applied to the batch. A page that fails to read does not sink the batch: the response reports failedPages so the parent can re-shoot just those pages; only when every page fails does the action error. It first judges what each photo contains (photoContent): a questions-only photo closes the correction line entirely — no candidate may claim the child wrote or chose anything wrong. Diagnosis (why an exercise went wrong) is backstage only: it decides which words are picked, the learning unit, and how cards are made; the front-facing fields are the word, its original sentence, and one plain reason it is worth remembering. Legacy one-shot path, superseded by the find-job actions (startFindJob / processFindJob / getFindJob), which store the photos only temporarily on the server and delete them the moment reading finishes.",
    request: z.object({
      images: z
        .array(
          z.object({
            imageBase64: z.string().min(100).max(12_000_000),
            mimeType: z.enum(["image/jpeg", "image/png"]),
          }),
        )
        .min(1)
        .max(6),
    }),
    response: homeworkPageSchema.extend({
      pageCount: z.number(),
      failedPages: z.number(),
    }),
    async handler(ctx, args) {
      const level = await getLevel(ctx);
      const readOnePage = (image: {
        imageBase64: string;
        mimeType: "image/jpeg" | "image/png";
      }): Promise<HomeworkPageOut> => readHomeworkPage(ctx, image, level);

      // Read the pages with a small pool (3 at a time): parallel enough
      // that a 6-page exam does not take six sequential reads, bounded
      // enough not to hammer the inference service. A page that throws
      // (blur, timeout) is counted and skipped — the batch survives it.
      const pages: (HomeworkPageOut | null)[] = args.images.map(() => null);
      let failedPages = 0;
      let cursor = 0;
      const worker = async () => {
        while (cursor < args.images.length) {
          const i = cursor;
          cursor += 1;
          const img = args.images[i];
          if (!img) continue;
          try {
            pages[i] = await readOnePage(img);
          } catch {
            failedPages += 1;
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(3, args.images.length) },
          () => worker(),
        ),
      );
      const okPages = pages.filter(
        (p): p is HomeworkPageOut => p !== null,
      );
      if (okPages.length === 0) {
        throw new Error("analyzeHomeworkPhoto: no page could be read");
      }
      const merged = mergeHomeworkPages(okPages);
      return { ...merged, pageCount: args.images.length, failedPages };
    },
  }),

  startFindJob: defineAction({
    description:
      "Submits one batch of photographed homework pages (1–6) as a server-side find job and returns its jobId immediately. The photos are stored TEMPORARILY on the server (ctx.blobs under findjob/<jobId>/page-<i>.jpg plus find_job_pages rows) — the parent approved exactly this: temporary storage, deleted the moment recognition finishes (and also on failure, timeout, or expiry). A background task is spawned to drive processFindJob; if spawning fails the job stays queued and the client's polling kick drives it instead.",
    request: z.object({
      images: z
        .array(
          z.object({
            imageBase64: z.string().min(100).max(12_000_000),
            mimeType: z.enum(["image/jpeg", "image/png"]),
          }),
        )
        .min(1)
        .max(6),
    }),
    response: z.object({ jobId: z.string(), spawned: z.boolean() }),
    async handler(ctx, args) {
      await sweepExpiredFindJobs(ctx);
      const level = await getLevel(ctx);
      const db = ctx.db<typeof schema>();
      const jobId = crypto.randomUUID();
      const now = Date.now();
      const keys = args.images.map(
        (_, i) => `findjob/${jobId}/page-${i}.jpg`,
      );
      for (let i = 0; i < args.images.length; i += 1) {
        const img = args.images[i];
        const key = keys[i];
        if (!img || !key) continue;
        await ctx.blobs.put(key, base64ToBytes(img.imageBase64), {
          contentType: img.mimeType,
        });
        await db.insert(schema.findJobPages).values({
          jobId,
          idx: i,
          mimeType: img.mimeType,
          imageBase64: img.imageBase64,
        });
      }
      await db.insert(schema.findJobs).values({
        id: jobId,
        status: "queued",
        pageCount: args.images.length,
        level,
        photoKeysJson: JSON.stringify(keys),
        analysisJson: null,
        resultJson: null,
        error: null,
        photosDeleted: 0,
        createdAtMs: now,
        updatedAtMs: now,
      });
      let spawned = false;
      try {
        const res = await ctx.agent.spawnTask(
          `In the 儿童英语单词闪卡 web artifact (slug er-tong-ying-yu-dan-ci-shan-qia-2), a parent just submitted homework photos and a server-side find job was created with jobId "${jobId}". Drive it to completion: invoke the artifact's processFindJob action with {"jobId": "${jobId}"}. If it returns status reading or making with busy true, wait about a minute and invoke processFindJob again; repeat for up to 15 minutes until getFindJob reports the job done or failed. The photos are temporary and processFindJob itself deletes them when the job finishes — your only job is to keep invoking processFindJob until the job is done or failed. Do not send the user any message; the result appears inside the artifact.`,
          {
            expectsAction: "processFindJob",
            dedupeKey: `findjob-${jobId}`,
          },
        );
        spawned = res.ok;
      } catch {
        spawned = false;
      }
      return { jobId, spawned };
    },
  }),

  processFindJob: defineAction({
    description:
      "Advances one find job to completion (idempotent and resumable): claims the job, reads any not-yet-read pages from its temporary server-side photos with the same vision prompt and gates as analyzeHomeworkPhoto (per-page results are persisted after each wave of 3, so an interrupted run resumes where it stopped), merges the pages, generates the recommended-tier flashcards, stores only the word result, and deletes every temporary photo copy before marking the job done. On any failure the job is marked failed and the photos are still deleted. A concurrent call while another run is fresh (<15 min heartbeat) returns busy instead of double-processing.",
    request: z.object({ jobId: z.string().min(1).max(80) }),
    response: z.object({
      jobId: z.string(),
      status: z.enum([
        "queued",
        "reading",
        "making",
        "done",
        "failed",
        "not_found",
      ]),
      busy: z.boolean(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{
      jobId: string;
      status:
        | "queued"
        | "reading"
        | "making"
        | "done"
        | "failed"
        | "not_found";
      busy: boolean;
    }> {
      await sweepExpiredFindJobs(ctx);
      const db = ctx.db<typeof schema>();
      let job = await loadFindJob(ctx, args.jobId);
      if (!job) return { jobId: args.jobId, status: "not_found", busy: false };
      if (job.status === "done" || job.status === "failed") {
        return { jobId: job.id, status: job.status, busy: false };
      }
      // Claim: a fresh in-progress heartbeat means another runner is
      // on it — back off instead of double-reading. A stale one means
      // that runner died; take over from the persisted progress.
      if (
        (job.status === "reading" || job.status === "making") &&
        Date.now() - job.updatedAtMs < FIND_JOB_STALE_MS
      ) {
        return { jobId: job.id, status: job.status, busy: true };
      }
      await db
        .update(schema.findJobs)
        .set({
          status: job.status === "making" ? "making" : "reading",
          updatedAtMs: Date.now(),
        })
        .where(eq(schema.findJobs.id, job.id));
      job = (await loadFindJob(ctx, args.jobId)) ?? job;

      try {
        const analysis: FindJobAnalysis = parseJsonOr<FindJobAnalysis>(
          job.analysisJson,
          {
            pages: Array.from({ length: job.pageCount }, () => null),
            attempted: Array.from({ length: job.pageCount }, () => false),
            failedPages: 0,
            merged: null,
          },
        );
        while (analysis.pages.length < job.pageCount) {
          analysis.pages.push(null);
          analysis.attempted.push(false);
        }

        if (!analysis.merged) {
          // Reading phase: waves of 3 pages, progress persisted after
          // each wave so a dead runner loses at most one wave.
          const pageRows = await db
            .select()
            .from(schema.findJobPages)
            .where(eq(schema.findJobPages.jobId, job.id));
          const byIdx = new Map(pageRows.map((r) => [r.idx, r]));
          const missing: number[] = [];
          for (let i = 0; i < job.pageCount; i += 1) {
            if (!analysis.attempted[i]) missing.push(i);
          }
          for (let s = 0; s < missing.length; s += 3) {
            const wave = missing.slice(s, s + 3);
            await Promise.all(
              wave.map(async (i) => {
                const row = byIdx.get(i);
                analysis.attempted[i] = true;
                if (!row) {
                  analysis.failedPages += 1;
                  return;
                }
                try {
                  analysis.pages[i] = await readHomeworkPage(
                    ctx,
                    {
                      imageBase64: row.imageBase64,
                      mimeType:
                        row.mimeType === "image/png"
                          ? "image/png"
                          : "image/jpeg",
                    },
                    (job?.level ?? "movers") as
                      | "starters"
                      | "movers"
                      | "flyers",
                  );
                } catch {
                  analysis.failedPages += 1;
                }
              }),
            );
            await db
              .update(schema.findJobs)
              .set({
                status: "reading",
                analysisJson: JSON.stringify(analysis),
                updatedAtMs: Date.now(),
              })
              .where(eq(schema.findJobs.id, job.id));
          }
          const okPages = analysis.pages.filter(
            (p): p is HomeworkPageOut => p !== null,
          );
          if (okPages.length === 0) {
            await failFindJob(ctx, job, "no page could be read");
            return { jobId: job.id, status: "failed", busy: false };
          }
          analysis.merged = candidatesFromPage(
            mergeHomeworkPages(okPages),
          );
          await db
            .update(schema.findJobs)
            .set({
              status: "making",
              analysisJson: JSON.stringify(analysis),
              updatedAtMs: Date.now(),
            })
            .where(eq(schema.findJobs.id, job.id));
        }

        // Making phase: recommended tier becomes cards right away
        // (generateAndInsert dedupes against the existing library, so
        // re-entering this phase after a crash cannot double-make).
        const merged = analysis.merged;
        const gen = await generateAndInsert(
          ctx,
          merged.recommended,
          job.level,
        );
        const skipped = new Set(
          gen.skipped.map((s) => s.trim().toLowerCase()),
        );
        const createdWords = merged.recommended
          .filter((c) => !skipped.has(c.word.trim().toLowerCase()))
          .map((c) => c.word);
        const result: FindResult = {
          createdWords,
          created: createdWords.length,
          all: merged.recommended,
          optional: merged.optional,
          questionsOnly: merged.questionsOnly,
          skippedCount: merged.skippedCount,
          failedPages: analysis.failedPages,
        };
        // The word result is durable now — the photos have served
        // their purpose and are deleted before the job is marked done.
        await deleteFindJobPhotos(ctx, job);
        await db
          .update(schema.findJobs)
          .set({
            status: "done",
            resultJson: JSON.stringify(result),
            analysisJson: null,
            photosDeleted: 1,
            updatedAtMs: Date.now(),
          })
          .where(eq(schema.findJobs.id, job.id));
        ctx.invalidateQueries();
        return { jobId: job.id, status: "done", busy: false };
      } catch (e) {
        await failFindJob(
          ctx,
          job,
          e instanceof Error ? e.message : "processFindJob failed",
        );
        return { jobId: job.id, status: "failed", busy: false };
      }
    },
  }),

  getFindJob: defineAction({
    description:
      "Returns one find job's status and, once done, its word result (made cards + optional pool). Also reports photosDeleted so the temporary-photo promise is verifiable. Returns job=null for an unknown id.",
    request: z.object({ jobId: z.string().min(1).max(80) }),
    response: z.object({ job: findJobOutSchema.nullable() }),
    async handler(ctx, args) {
      await sweepExpiredFindJobs(ctx);
      const job = await loadFindJob(ctx, args.jobId);
      return { job: job ? findJobToOut(job) : null };
    },
  }),

  getLatestFindJob: defineAction({
    description:
      "Returns the most recent find job (status + word result when done), or job=null when no job exists — this is what lets a reopened page adopt a job that finished while it was closed.",
    request: z.object({}),
    response: z.object({ job: findJobOutSchema.nullable() }),
    async handler(ctx) {
      await sweepExpiredFindJobs(ctx);
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.findJobs)
        .orderBy(desc(schema.findJobs.createdAtMs));
      const job = rows[0];
      return { job: job ? findJobToOut(job) : null };
    },
  }),

  getExamplePage: defineAction({
    description:
      "Returns the built-in example homework page (a labelled demo) with its exercises and word list.",
    request: z.object({}),
    response: homeworkPageSchema,
    async handler() {
      return EXAMPLE_PAGE;
    },
  }),

  getOverview: defineAction({
    description:
      "Returns the home overview: child level, due/new/graduated counts, streak of due-cleared days, and today's rescued count.",
    request: z.object({ day: z.string() }),
    response: z.object({
      level: z.enum(["starters", "movers", "flyers"]),
      autoRead: z.boolean(),
      dueCount: z.number(),
      newCount: z.number(),
      digCount: z.number(),
      graduatedCount: z.number(),
      totalCount: z.number(),
      streak: z.number(),
      todayRescued: z.number(),
      todayCleared: z.boolean(),
      dueWords: z.array(
        z.object({
          id: z.number(),
          word: z.string(),
          overdueDays: z.number(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const level = await getLevel(ctx);
      const autoRead = await getAutoRead(ctx);
      const now = Date.now();
      const rows = await db.select().from(schema.cards);
      const due = rows
        .filter((r) => r.state !== "new" && r.dueAt > 0 && r.dueAt <= now)
        .sort((a, b) => a.dueAt - b.dueAt);
      const newCount = rows.filter((r) => r.state === "new").length;
      // Diggable = met at least once, not yet graduated (a scene is unlit).
      const digCount = rows.filter((r) => r.state === "learning").length;
      const graduatedCount = rows.filter(
        (r) => r.state === "graduated",
      ).length;

      // Record that today had due work (streak bookkeeping).
      if (due.length > 0) {
        const act = await db
          .select()
          .from(schema.activity)
          .where(eq(schema.activity.day, args.day));
        if (act[0]) {
          if (act[0].hadDue !== 1) {
            await db
              .update(schema.activity)
              .set({ hadDue: 1 })
              .where(eq(schema.activity.day, args.day));
          }
        } else {
          await db.insert(schema.activity).values({
            day: args.day,
            hadDue: 1,
            dueCleared: 0,
            rescued: 0,
            rescuedIds: "[]",
          });
        }
      }

      const acts = await db
        .select()
        .from(schema.activity)
        .orderBy(desc(schema.activity.day));
      const today = acts.find((a) => a.day === args.day);
      // Streak: due-cleared days, with free automatic pause days
      // padding up to two consecutive recorded misses (see
      // computeStreakInfo). Today may still be pending.
      const { streak } = computeStreakInfo(acts, args.day);

      return {
        level,
        autoRead,
        dueCount: due.length,
        newCount,
        digCount,
        graduatedCount,
        totalCount: rows.length,
        streak,
        todayRescued: today?.rescued ?? 0,
        todayCleared: today?.dueCleared === 1,
        dueWords: due.slice(0, 12).map((r) => ({
          id: r.id,
          word: r.word,
          overdueDays: Math.max(
            0,
            Math.floor((now - r.dueAt) / DAY_MS),
          ),
        })),
      };
    },
  }),

  setLevel: defineAction({
    description: "Sets the child's Cambridge YLE level used for above-level word detection.",
    request: z.object({
      level: z.enum(["starters", "movers", "flyers"]),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      if (rows[0]) {
        await db
          .update(schema.settings)
          .set({ childLevel: args.level })
          .where(eq(schema.settings.id, 1));
      } else {
        await db
          .insert(schema.settings)
          .values({ id: 1, childLevel: args.level });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  setAutoRead: defineAction({
    description:
      "Sets the parent's auto read-aloud switch: when on, display faces read themselves aloud as they appear.",
    request: z.object({
      enabled: z.boolean(),
    }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.settings);
      if (rows[0]) {
        await db
          .update(schema.settings)
          .set({ autoRead: args.enabled ? 1 : 0 })
          .where(eq(schema.settings.id, 1));
      } else {
        await db.insert(schema.settings).values({
          id: 1,
          childLevel: "movers",
          autoRead: args.enabled ? 1 : 0,
        });
      }
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  generateCards: defineAction({
    description:
      "Generates flashcards for the parent-confirmed candidate words and stores them as new cards.",
    request: z.object({
      candidates: z
        .array(
          z.object({
            word: z.string().min(1).max(40),
            sourceType: z.enum(["spelling", "meaning", "above", "manual"]),
            sourceRef: z.string().max(120),
            wordLevel: z.string().max(40),
            hint: z.string().max(600),
          }),
        )
        .min(1)
        .max(20),
    }),
    response: z.object({
      created: z.number(),
      skipped: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const level = await getLevel(ctx);
      const out = await generateAndInsert(ctx, args.candidates, level);
      ctx.invalidateQueries();
      return out;
    },
  }),

  addManualWord: defineAction({
    description: "Generates one flashcard for a word the parent typed in manually.",
    request: z.object({ word: z.string().min(1).max(40) }),
    response: z.object({
      created: z.number(),
      skipped: z.array(z.string()),
    }),
    async handler(ctx, args) {
      const level = await getLevel(ctx);
      const out = await generateAndInsert(
        ctx,
        [
          {
            word: args.word.trim(),
            sourceType: "manual",
            sourceRef: "家长手动添加",
            wordLevel: "",
            hint: "",
          },
        ],
        level,
      );
      ctx.invalidateQueries();
      return out;
    },
  }),

  getStudyQueue: defineAction({
    description:
      "Returns the study queue: due cards (oldest debt first) or new cards, with full card content.",
    request: z.object({
      kind: z.enum(["due", "new"]),
      limit: z.number().int().positive().max(15).default(10),
    }),
    response: z.object({ cards: z.array(cardSchema) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const now = Date.now();
      const rows = await db.select().from(schema.cards);
      const picked =
        args.kind === "due"
          ? rows
              .filter(
                (r) => r.state !== "new" && r.dueAt > 0 && r.dueAt <= now,
              )
              .sort((a, b) => a.dueAt - b.dueAt)
              .slice(0, args.limit)
          : rows
              .filter((r) => r.state === "new")
              .sort((a, b) => a.id - b.id)
              .slice(0, args.limit);
      return { cards: picked.map(rowToCard) };
    },
  }),

  getDigQueue: defineAction({
    description:
      "Returns the dig-level queue: cards already met but not yet graduated (at least one mastery scene still unlit), soonest due first.",
    request: z.object({
      limit: z.number().int().positive().max(15).default(10),
    }),
    response: z.object({ cards: z.array(cardSchema) }),
    async handler(ctx, args) {
      const db = ctx.db<typeof schema>();
      const rows = await db.select().from(schema.cards);
      const picked = rows
        .filter((r) => r.state === "learning")
        .sort((a, b) => a.dueAt - b.dueAt)
        .slice(0, args.limit);
      return { cards: picked.map(rowToCard) };
    },
  }),

  submitReview: defineAction({
    description:
      "Records one practice attempt. Dig attempts carry the raw behavior of the whole review visit; the server derives ONE FSRS grade from it (again/hard/good — never easy) and that grade alone moves the schedule. Dig modes also light mastery scenes; all four scenes graduate the card.",
    request: z.object({
      cardId: z.number().int().positive(),
      mode: z.enum(["warmup", "cloze", "dictation", "sentence", "recall"]),
      correct: z.boolean(),
      typedAnswer: z.string().max(200).optional(),
      rating: z.enum(["again", "hard", "good", "easy"]).optional(),
      // Raw behavior of this review visit, sent with the dig attempt:
      // the front meaning-guess (旁证) plus this dig scene's first
      // attempt. firstResponseMs is time-to-first-response (first tap
      // / first keystroke), never total typing time.
      behavior: z
        .object({
          guessFirstCorrect: z.boolean().optional(),
          guessFirstResponseMs: z.number().int().min(0).max(600_000).nullable().optional(),
          warmKind: z.enum(["choice", "build"]).nullable().optional(),
          warmFirstCorrect: z.boolean().optional(),
          digFirstCorrect: z.boolean(),
          digAttempts: z.number().int().min(1).max(20),
          hintUsed: z.boolean(),
          typoTolerated: z.boolean(),
          digFirstResponseMs: z.number().int().min(0).max(600_000).nullable().optional(),
        })
        .optional(),
      day: z.string(),
    }),
    response: z.object({
      ok: z.literal(true),
      graduated: z.boolean(),
      scenes: z.object({
        card: z.boolean(),
        cloze: z.boolean(),
        dictation: z.boolean(),
        sentence: z.boolean(),
      }),
      nextDueAt: z.number(),
      dueRemaining: z.number(),
    }),
    async handler(
      ctx,
      args,
    ): Promise<{
      ok: true;
      graduated: boolean;
      scenes: CardOut["scenes"];
      nextDueAt: number;
      dueRemaining: number;
    }> {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.cards)
        .where(eq(schema.cards.id, args.cardId));
      const card = rows[0];
      if (!card) throw new Error("submitReview: card not found");

      const now = Date.now();
      const startOfToday = dayStartMs(args.day);
      const wasOverdue =
        card.dueAt > 0 && card.dueAt < startOfToday && card.state !== "new";

      const isDig =
        args.mode === "cloze" ||
        args.mode === "dictation" ||
        args.mode === "sentence";

      // The ONE grade for this review visit, if this submission
      // carries one. A dig attempt derives its grade from the visit's
      // raw behavior; a legacy recall submission keeps the child's
      // self-rating (kept only so an old client still works — the
      // current client never sends it); a warmup tap carries no
      // grade at all: recognising is not remembering.
      let grade: "again" | "hard" | "good" | "easy" | null = null;
      let gradeSource: "self" | "behavior" | null = null;
      let behaviorJson: string | null = null;
      if (isDig) {
        const behavior: BehaviorIn = args.behavior ?? {
          digFirstCorrect: args.correct,
          digAttempts: 1,
          hintUsed: false,
          typoTolerated: false,
          digFirstResponseMs: null,
        };
        behaviorJson = JSON.stringify(behavior);
        const baseline =
          behavior.digFirstCorrect &&
          behavior.digAttempts === 1 &&
          !behavior.hintUsed &&
          !behavior.typoTolerated
            ? await latencyBaseline(ctx, args.mode as DigMode)
            : null;
        grade = deriveGrade(behavior, baseline);
        gradeSource = "behavior";
      } else if (args.mode === "recall" && args.rating) {
        grade = args.rating;
        gradeSource = "self";
      }

      await db.insert(schema.reviews).values({
        cardId: card.id,
        mode: args.mode,
        correct: args.correct ? 1 : 0,
        typedAnswer: args.typedAnswer ?? null,
        rating: grade,
        gradeSource,
        behaviorJson,
      });

      let stability = card.stability;
      let dueAt = card.dueAt;
      let lapses = card.lapses;
      let reps = card.reps;
      let state = card.state;
      let sceneCard = card.sceneCard;
      let sceneCloze = card.sceneCloze;
      let sceneDictation = card.sceneDictation;
      let sceneSentence = card.sceneSentence;
      let positive = false;

      // The FSRS update — the ONLY writer of stability and due_at in
      // the product. The multipliers are the ones the schedule has
      // always used; what changed is purely where the grade comes
      // from. (The old side rules are gone: a wrong dig used to halve
      // stability and drag due_at to +0.5 day by itself, and a wrong
      // sentence did the same — scheduling that bypassed the grade.
      // Now a failed dig forms an Again grade and FSRS alone decides
      // when the word comes back.)
      if (grade !== null) {
        reps += 1;
        if (state === "new") state = "learning";
        if (grade === "again") {
          lapses += 1;
          stability = 0.4;
        } else if (grade === "hard") {
          stability = stability > 0 ? stability * 1.25 : 1;
          if (stability < 1) stability = 1;
        } else if (grade === "good") {
          stability = stability > 0 ? stability * 2.4 : 2.5;
          sceneCard = 1;
          positive = true;
        } else {
          // easy: reachable only from a legacy self-rated submission;
          // behavior derivation never emits it.
          stability = stability > 0 ? stability * 3.4 : 4.5;
          sceneCard = 1;
          positive = true;
        }
        dueAt = now + Math.round(stability * DAY_MS);
      }
      // A passed dig lights its mastery scene whatever the grade was
      // (the scene was genuinely done); a failed dig lights nothing.
      if (isDig && args.correct) {
        if (args.mode === "cloze") sceneCloze = 1;
        else if (args.mode === "dictation") sceneDictation = 1;
        else sceneSentence = 1;
        positive = true;
      }

      let graduated = false;
      if (
        sceneCard === 1 &&
        sceneCloze === 1 &&
        sceneDictation === 1 &&
        sceneSentence === 1 &&
        state !== "graduated"
      ) {
        state = "graduated";
        graduated = true;
        // No date is set here: the FSRS grade above already placed
        // the next reunion. Graduation changes the card's state,
        // never its schedule — FSRS stays the only scheduler.
      }

      await db
        .update(schema.cards)
        .set({
          stability,
          dueAt,
          lapses,
          reps,
          state,
          sceneCard,
          sceneCloze,
          sceneDictation,
          sceneSentence,
        })
        .where(eq(schema.cards.id, card.id));

      // Rescued = an overdue word pulled back today, counted once per card.
      if (wasOverdue && positive) {
        const actRows = await db
          .select()
          .from(schema.activity)
          .where(eq(schema.activity.day, args.day));
        const act = actRows[0];
        const ids = parseJsonArray<number>(act?.rescuedIds ?? "[]", []);
        if (!ids.includes(card.id)) {
          ids.push(card.id);
          if (act) {
            await db
              .update(schema.activity)
              .set({ rescued: ids.length, rescuedIds: JSON.stringify(ids) })
              .where(eq(schema.activity.day, args.day));
          } else {
            await db.insert(schema.activity).values({
              day: args.day,
              hadDue: 1,
              dueCleared: 0,
              rescued: ids.length,
              rescuedIds: JSON.stringify(ids),
            });
          }
        }
      }

      const remaining = await dueCount(ctx, Date.now());
      if (remaining === 0) {
        await markDueCleared(ctx, args.day);
      }

      ctx.invalidateQueries();
      return {
        ok: true,
        graduated,
        scenes: {
          card: sceneCard === 1,
          cloze: sceneCloze === 1,
          dictation: sceneDictation === 1,
          sentence: sceneSentence === 1,
        },
        nextDueAt: dueAt,
        dueRemaining: remaining,
      };
    },
  }),

  listCards: defineAction({
    description: "Lists all flashcards with content, mastery scenes and schedule.",
    request: z.object({}),
    response: z.object({ cards: z.array(cardSchema) }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const rows = await db
        .select()
        .from(schema.cards)
        .orderBy(desc(schema.cards.id));
      return { cards: rows.map(rowToCard) };
    },
  }),

  deleteCard: defineAction({
    description: "Deletes one flashcard and its review history.",
    request: z.object({ id: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const db = ctx.db<typeof schema>();
      await db
        .delete(schema.reviews)
        .where(eq(schema.reviews.cardId, args.id));
      await db.delete(schema.cards).where(eq(schema.cards.id, args.id));
      ctx.invalidateQueries();
      return { ok: true };
    },
  }),

  getErrorArchive: defineAction({
    description:
      "Returns the error archive: confusion pairs, spelling-tail fingerprints, and stubborn words aggregated from review history.",
    request: z.object({}),
    response: z.object({
      confusionPairs: z.array(
        z.object({
          word: z.string(),
          contrastWord: z.string(),
          noteZh: z.string().nullable(),
          wrongCount: z.number(),
        }),
      ),
      spellingTails: z.array(
        z.object({
          wrongTail: z.string(),
          typedTail: z.string(),
          count: z.number(),
          words: z.array(z.string()),
        }),
      ),
      stubborn: z.array(
        z.object({
          id: z.number(),
          word: z.string(),
          meaningZh: z.string(),
          lapses: z.number(),
          state: z.enum(["new", "learning", "graduated"]),
        }),
      ),
      totalReviews: z.number(),
      totalWrong: z.number(),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const cardRows = await db.select().from(schema.cards);
      const reviewRows = await db.select().from(schema.reviews);
      const cardById = new Map(cardRows.map((r) => [r.id, r]));

      const confusionPairs = cardRows
        .filter((r) => r.contrastWord)
        .map((r) => ({
          word: r.word,
          contrastWord: r.contrastWord ?? "",
          noteZh: r.contrastNoteZh,
          wrongCount: reviewRows.filter(
            (rev) =>
              rev.cardId === r.id &&
              rev.correct === 0 &&
              rev.mode !== "warmup" &&
              rev.mode !== "speak",
          ).length,
        }))
        .filter((p) => p.wrongCount > 0)
        .sort((a, b) => b.wrongCount - a.wrongCount);

      const tailMap = new Map<
        string,
        { wrongTail: string; typedTail: string; count: number; words: Set<string> }
      >();
      for (const rev of reviewRows) {
        if (
          (rev.mode !== "cloze" && rev.mode !== "dictation") ||
          rev.correct === 1 ||
          !rev.typedAnswer
        ) {
          continue;
        }
        const card = cardById.get(rev.cardId);
        if (!card) continue;
        const word = card.word.toLowerCase();
        const typed = rev.typedAnswer.trim().toLowerCase();
        if (!typed || typed === word) continue;
        let p = 0;
        while (p < word.length && p < typed.length && word[p] === typed[p]) {
          p += 1;
        }
        const wrongTail = word.slice(p) || word;
        const typedTail = typed.slice(p) || "（漏写）";
        const key = `${wrongTail}→${typedTail}`;
        const entry = tailMap.get(key) ?? {
          wrongTail,
          typedTail,
          count: 0,
          words: new Set<string>(),
        };
        entry.count += 1;
        entry.words.add(card.word);
        tailMap.set(key, entry);
      }
      const spellingTails = [...tailMap.values()]
        .map((e) => ({
          wrongTail: e.wrongTail,
          typedTail: e.typedTail,
          count: e.count,
          words: [...e.words],
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);

      const stubborn = cardRows
        .filter((r) => r.lapses > 0)
        .sort((a, b) => b.lapses - a.lapses)
        .slice(0, 8)
        .map((r) => ({
          id: r.id,
          word: r.word,
          meaningZh: r.meaningZh,
          lapses: r.lapses,
          state: r.state,
        }));

      return {
        confusionPairs,
        spellingTails,
        stubborn,
        totalReviews: reviewRows.length,
        totalWrong: reviewRows.filter(
          (r) => r.correct === 0 && !r.speechFailureReason,
        ).length,
      };
    },
  }),

  getIncentives: defineAction({
    description:
      "Returns the incentive layer, all of it derived from real learning records: today's three daily quests in FSRS language (clear today's due queue, re-fix previously failed words, reach a combo target set from the child's own baseline), tiered mastery badges anchored to FSRS stability and graduation, progress growth (graduated words over time), the parent's weekly report (this week vs last), a monthly recap, and streak info including free automatic pause days used. No currency, no points for opening the app.",
    request: z.object({ day: z.string() }),
    response: incentivesResponse,
    async handler(ctx, args): Promise<z.infer<typeof incentivesResponse>> {
      const db = ctx.db<typeof schema>();
      const cardRows = await db.select().from(schema.cards);
      const reviewRows = await db.select().from(schema.reviews);
      const acts = await db.select().from(schema.activity);

      const now = Date.now();
      const todayStart = dayStartMs(args.day);
      const todayEnd = todayStart + DAY_MS;
      const inWindow = (t: number, start: number, end: number) =>
        t >= start && t < end;
      const isDig = (r: ReviewRow) =>
        r.mode === "cloze" || r.mode === "dictation" || r.mode === "sentence";

      const streakInfo = computeStreakInfo(acts, args.day);
      const gradTimes = graduationTimes(reviewRows);
      const dueNow = cardRows.filter(
        (r) => r.state !== "new" && r.dueAt > 0 && r.dueAt <= now,
      ).length;

      /* ---- daily quests (FSRS language, winnable by construction) ---- */
      const reviewsToday = reviewRows.filter((r) =>
        inWindow(r.createdAt.getTime(), todayStart, todayEnd),
      );
      const reviewedBeforeToday = new Set(
        reviewRows
          .filter((r) => r.createdAt.getTime() < todayStart)
          .map((r) => r.cardId),
      );
      // Quest 1 — clear today's due queue. Progress = returning cards
      // (met before today) whose dig visit happened today: each such
      // visit moved that card's due date forward through its grade.
      const clearedIds = new Set(
        reviewsToday
          .filter((r) => isDig(r) && reviewedBeforeToday.has(r.cardId))
          .map((r) => r.cardId),
      );
      const questDue = {
        id: "clear-due",
        title: "清掉今天到期的词",
        detail:
          dueNow > 0
            ? `还有 ${dueNow} 个到期的词在等`
            : "今天到期的词都清完了",
        progress: clearedIds.size,
        target: dueNow + clearedIds.size,
        done: dueNow === 0,
      };

      // Quest 2 — yesterday's (or earlier) wrong words, fixed today.
      // A card is pending at day start when its latest Again grade is
      // before today and no correct dig has landed after that Again
      // yet. The target is capped at 3 so the quest stays winnable
      // on a heavy day; the anchor event is the best reward tier in
      // the book: 奖励「改对了」.
      const latestAgain = new Map<number, number>();
      for (const r of reviewRows) {
        if (r.rating !== "again") continue;
        const t = r.createdAt.getTime();
        if (t > (latestAgain.get(r.cardId) ?? -Infinity)) {
          latestAgain.set(r.cardId, t);
        }
      }
      const fixedAfter = (
        cardId: number,
        afterMs: number,
        beforeMs: number,
      ): boolean =>
        reviewRows.some(
          (r) =>
            r.cardId === cardId &&
            isDig(r) &&
            r.correct === 1 &&
            r.createdAt.getTime() > afterMs &&
            r.createdAt.getTime() < beforeMs,
        );
      let pendingFix = 0;
      let fixedToday = 0;
      for (const [cardId, againAt] of latestAgain) {
        if (againAt >= todayStart) continue;
        if (fixedAfter(cardId, againAt, todayStart)) continue;
        pendingFix += 1;
        if (fixedAfter(cardId, againAt, todayEnd)) fixedToday += 1;
      }
      const fixTarget = Math.min(pendingFix, 3);
      const questFix = {
        id: "fix-wrong",
        title: "把错词回炉改对",
        detail:
          fixTarget === 0
            ? "没有错词等着回炉"
            : `以前没写对的词，今天写对 ${Math.min(fixedToday, fixTarget)} 个`,
        progress: fixedToday,
        target: fixTarget,
        done: fixTarget === 0 || fixedToday >= fixTarget,
      };

      // Quest 3 — combo target from the child's OWN baseline: the
      // median of his best first-try runs on past days, clamped to
      // [3, 8]; with no history the target is 3. League craft,
      // translated: the bar is set so he can win it.
      const byDay = new Map<string, ReviewRow[]>();
      for (const r of reviewRows) {
        const key = r.createdAt.toISOString().slice(0, 10);
        const list = byDay.get(key) ?? [];
        list.push(r);
        byDay.set(key, list);
      }
      const todayKeyIso = new Date(todayStart).toISOString().slice(0, 10);
      const pastBests = [...byDay.entries()]
        .filter(([k]) => k < todayKeyIso)
        .sort((a, b) => b[0].localeCompare(a[0]))
        .slice(0, 14)
        .map(([, rows]) => bestCombo(rows))
        .filter((n) => n > 0)
        .sort((a, b) => a - b);
      const medianBest =
        pastBests.length > 0
          ? (pastBests[Math.floor(pastBests.length / 2)] ?? 3)
          : 3;
      const comboTarget = Math.max(3, Math.min(8, medianBest));
      const comboToday = bestCombo(reviewsToday);
      const questCombo = {
        id: "combo",
        title: "连对小目标",
        detail: `第一次就答对，连成 ${comboTarget} 个`,
        progress: comboToday,
        target: comboTarget,
        done: comboToday >= comboTarget,
      };

      /* ---- tiered mastery badges (FSRS-anchored definitions) ---- */
      const graduatedCount = cardRows.filter(
        (r) => r.state === "graduated",
      ).length;
      const longTermCount = cardRows.filter((r) => r.stability >= 30).length;
      const totalRescued = acts.reduce((a, r) => a + r.rescued, 0);
      const badgeDefs: {
        id: string;
        name: string;
        desc: string;
        value: number;
        tiers: number[];
      }[] = [
        {
          id: "graduate",
          name: "毕业收藏家",
          desc: "四关全过、真正毕业的词",
          value: graduatedCount,
          tiers: [1, 5, 10, 25, 50, 100, 200],
        },
        {
          id: "longterm",
          name: "记得牢",
          desc: "FSRS 说能记满一个月的词",
          value: longTermCount,
          tiers: [1, 3, 5, 10, 25, 50],
        },
        {
          id: "rescue",
          name: "捞回英雄",
          desc: "把快忘的词救回来的次数",
          value: totalRescued,
          tiers: [1, 5, 10, 25, 50, 100],
        },
        {
          id: "streak",
          name: "坚持小火苗",
          desc: "到期清零的连胜天数",
          value: streakInfo.streak,
          tiers: [3, 7, 14, 30, 60, 100, 365],
        },
      ];
      const badges = badgeDefs.map((b) => {
        const tier = b.tiers.filter((t) => b.value >= t).length;
        return {
          id: b.id,
          name: b.name,
          desc: b.desc,
          value: b.value,
          tier,
          tiers: b.tiers,
          nextTarget: b.tiers[tier] ?? null,
        };
      });

      /* ---- progress made visible ---- */
      const gradValues = [...gradTimes.values()];
      const monthStart = dayStartMs(`${args.day.slice(0, 7)}-01`);
      const monthDate = new Date(monthStart);
      monthDate.setMonth(monthDate.getMonth() + 1);
      const monthEnd = monthDate.getTime();
      const progress = {
        graduatedTotal: graduatedCount,
        graduatedThisWeek: gradValues.filter((t) =>
          inWindow(t, todayStart - 6 * DAY_MS, todayEnd),
        ).length,
        graduatedThisMonth: gradValues.filter((t) =>
          inWindow(t, monthStart, monthEnd),
        ).length,
        longTermCount,
        totalPracticeDays: streakInfo.totalPracticeDays,
        totalCards: cardRows.length,
      };

      /* ---- weekly report + monthly recap (parent zone) ---- */
      const statsFor = (start: number, end: number) => {
        const rows = reviewRows.filter((r) =>
          inWindow(r.createdAt.getTime(), start, end),
        );
        const digs = rows.filter(isDig);
        const firsts = digs
          .map(firstTryCorrect)
          .filter((v): v is boolean => v !== null);
        const practiceDaySet = new Set(
          rows.map((r) =>
            Math.floor((r.createdAt.getTime() - todayStart) / DAY_MS),
          ),
        );
        return {
          reviews: rows.length,
          digFirstTotal: firsts.length,
          digFirstCorrect: firsts.filter(Boolean).length,
          newCards: cardRows.filter((c) =>
            inWindow(c.createdAt.getTime(), start, end),
          ).length,
          graduated: gradValues.filter((t) => inWindow(t, start, end)).length,
          rescued: acts
            .filter((a) => {
              const t = dayStartMs(a.day);
              return t >= start && t < end;
            })
            .reduce((sum, a) => sum + a.rescued, 0),
          practiceDays: practiceDaySet.size,
        };
      };
      const weekly = {
        thisWeek: statsFor(todayStart - 6 * DAY_MS, todayEnd),
        lastWeek: statsFor(todayStart - 13 * DAY_MS, todayStart - 6 * DAY_MS),
      };
      const monthly = {
        month: args.day.slice(0, 7),
        ...statsFor(monthStart, monthEnd),
        graduatedTotal: graduatedCount,
      };

      return {
        quests: [questDue, questFix, questCombo],
        badges,
        progress,
        weekly,
        monthly,
        streak: {
          current: streakInfo.streak,
          pausedDays: streakInfo.pausedDays,
          totalPracticeDays: streakInfo.totalPracticeDays,
        },
      };
    },
  }),

  exportData: defineAction({
    description:
      "Exports all flashcards and review history as JSON so the family can take their data with them.",
    request: z.object({}),
    response: z.object({
      exportedAt: z.string(),
      level: z.string(),
      cards: z.array(cardSchema),
      reviews: z.array(
        z.object({
          cardId: z.number(),
          word: z.string(),
          mode: z.string(),
          correct: z.boolean(),
          typedAnswer: z.string().nullable(),
          rating: z.string().nullable(),
          gradeSource: z.enum(["self", "behavior"]).nullable(),
          behavior: z.string().nullable(),
          speechFailureReason: z
            .enum(["unavailable", "denied", "no_result"])
            .nullable(),
          createdAt: z.string(),
        }),
      ),
    }),
    async handler(ctx) {
      const db = ctx.db<typeof schema>();
      const level = await getLevel(ctx);
      const cardRows = await db
        .select()
        .from(schema.cards)
        .orderBy(asc(schema.cards.id));
      const reviewRows = await db
        .select()
        .from(schema.reviews)
        .orderBy(asc(schema.reviews.id));
      const cardById = new Map(cardRows.map((r) => [r.id, r]));
      return {
        exportedAt: new Date().toISOString(),
        level,
        cards: cardRows.map(rowToCard),
        reviews: reviewRows.map((r) => ({
          cardId: r.cardId,
          word: cardById.get(r.cardId)?.word ?? "",
          mode: r.mode,
          correct: r.correct === 1,
          typedAnswer: r.typedAnswer,
          rating: r.rating,
          gradeSource: r.gradeSource,
          behavior: r.behaviorJson,
          speechFailureReason: r.speechFailureReason,
          createdAt: r.createdAt.toISOString(),
        })),
      };
    },
  }),
} satisfies ActionsModule;
