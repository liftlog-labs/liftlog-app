import { addPounds, formatPounds, parsePounds } from "../shared/load";
import { isValidLocalDate, normalizeName } from "../shared/names";
import { err, ok, type ErrorCode, type Result } from "../shared/result";
import type { SqlExecutor } from "../storage/sql";

export type ExerciseType = "barbell" | "dumbbell" | "machine" | "bodyweight" | "duration";

export type ExerciseSummary = {
  exerciseId: string;
  name: string;
  type: ExerciseType;
};

export type StoredSet = {
  setId: string;
  position: number;
  loadLb: string | null;
  reps: number | null;
  durationSec: number | null;
  assisted: boolean;
  note: string | null;
  line: string;
};

export type WorkoutEntry = {
  entryId: string;
  exerciseId: string;
  name: string;
  type: ExerciseType;
  position: number;
  barWeightLb: string | null;
  lastTimeHint: string | null;
  lastComparableSet: { set: StoredSet; date: string; currentWorkout: boolean } | null;
  sets: StoredSet[];
};

export type WorkoutDetail = {
  workoutId: string;
  date: string;
  label: string;
  startedAt: string | null;
  endedAt: string | null;
  entries: WorkoutEntry[];
};

export type HistoryItem = {
  workoutId: string;
  date: string;
  label: string;
  startedAt: string | null;
  endedAt: string | null;
  exerciseNames: string[];
  setCount: number;
};

export type SetDraft = {
  actionId: string;
  workoutId: string;
  exerciseId: string;
  totalLb?: string;
  platesLb?: string;
  reps?: number;
  durationSec?: number;
  assisted: boolean;
  note: string | null;
  now: string;
};

type ExerciseRow = {
  id: string;
  type: ExerciseType;
  bar_weight_lb: string | null;
  display_name: string;
};

class Rollback extends Error {
  constructor(readonly failure: { ok: false; code: ErrorCode; fields?: Record<string, string> }) {
    super(failure.code);
  }
}

function fail(code: ErrorCode, fields?: Record<string, string>): never {
  throw new Rollback(fields ? { ok: false, code, fields } : { ok: false, code });
}

export function createExercise(
  db: SqlExecutor,
  input: { actionId: string; name: string; type: ExerciseType; now: string },
): Result<{ exerciseId: string }> {
  const name = input.name.trim();
  const normalized = normalizeName(name);
  if (!name || !normalized) return err("INVALID_INPUT", { name: "Enter a name" });
  try {
    return db.transaction(() => {
      const taken = db.get<{ id: string }>(
        "SELECT id FROM exercise_name WHERE normalized_name = ? AND deleted_at IS NULL",
        [normalized],
      );
      if (taken) fail("NAME_TAKEN");
      const bar = input.type === "barbell" ? "45" : null;
      db.run(
        `INSERT INTO exercise (id, type, bar_weight_lb, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [input.actionId, input.type, bar, input.now, input.now],
      );
      db.run(
        `INSERT INTO exercise_name
          (id, exercise_id, display_name, normalized_name, is_canonical, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [`${input.actionId}-name`, input.actionId, name, normalized, input.now, input.now],
      );
      return ok({ exerciseId: input.actionId });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    return err("STORAGE_FAILURE");
  }
}

export function searchExercises(db: SqlExecutor, query: string): ExerciseSummary[] {
  const needle = normalizeName(query);
  const rows = db.all<ExerciseRow>(
    `SELECT e.id, e.type, e.bar_weight_lb, n.display_name
     FROM exercise e
     JOIN exercise_name n ON n.exercise_id = e.id AND n.is_canonical = 1 AND n.deleted_at IS NULL
     WHERE e.deleted_at IS NULL
     ORDER BY n.display_name`,
  );
  return rows
    .filter((row) => needle.length === 0 || normalizeName(row.display_name).includes(needle))
    .map(toSummary);
}

// Primary groups from the reviewed Coach catalog, keyed by built-in exercise ID.
const MUSCLES: Readonly<Record<string, "Chest" | "Back" | "Legs">> = {
  "seed-squat": "Legs",
  "seed-bench": "Chest",
  "seed-deadlift": "Legs",
  "seed-row": "Back",
  "seed-pulldown": "Back",
  "seed-leg-press": "Legs",
  "seed-pushup": "Chest",
};
export const exerciseGroups = ["All", "Chest", "Back", "Legs", "Unclassified"] as const;
export type ExerciseGroup = typeof exerciseGroups[number];

export function browseExercises(db: SqlExecutor, query: string, group: ExerciseGroup) {
  const needle = normalizeName(query);
  const matches = db.all<{ exercise_id: string; display_name: string }>(
    `SELECT exercise_id, display_name FROM exercise_name
     WHERE is_canonical = 0 AND deleted_at IS NULL AND ? != '' AND instr(normalized_name, ?) > 0
     ORDER BY display_name, id`, [needle, needle],
  );
  const aliases = new Map(matches.reverse().map((row) => [row.exercise_id, row.display_name]));
  return searchExercises(db, "").flatMap((exercise) => {
    const muscle = MUSCLES[exercise.exerciseId] ?? "Unclassified";
    const matchesName = normalizeName(exercise.name).includes(needle);
    const matchedAlias = matchesName ? null : aliases.get(exercise.exerciseId) ?? null;
    return (group === "All" || group === muscle) && (matchesName || matchedAlias)
      ? [{ ...exercise, muscle, matchedAlias }]
      : [];
  });
}

export function startWorkout(
  db: SqlExecutor,
  input: { actionId: string; label: string; now: string; localDate: string },
): Result<{ workoutId: string }> {
  const label = input.label.trim();
  if (!label) return err("INVALID_INPUT", { label: "Enter a label" });
  if (!isValidLocalDate(input.localDate)) return err("INVALID_INPUT", { date: "Invalid date" });
  try {
    return db.transaction(() => {
      const open = db.get<{ id: string }>(
        `SELECT id FROM workout
         WHERE deleted_at IS NULL AND ended_at IS NULL AND started_at IS NOT NULL`,
      );
      if (open) fail("LIVE_WORKOUT_EXISTS", { workoutId: open.id });
      db.run(
        `INSERT INTO workout
          (id, date, label, normalized_label, started_at, ended_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        [input.actionId, input.localDate, label, normalizeName(label), input.now, input.now, input.now],
      );
      return ok({ workoutId: input.actionId });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    return err("STORAGE_FAILURE");
  }
}

export function getOpenWorkoutId(db: SqlExecutor): string | null {
  const row = db.get<{ id: string }>(
    `SELECT id FROM workout
     WHERE deleted_at IS NULL AND ended_at IS NULL AND started_at IS NOT NULL`,
  );
  return row?.id ?? null;
}

export function getOpenWorkout(db: SqlExecutor): WorkoutDetail | null {
  const id = getOpenWorkoutId(db);
  return id ? getWorkout(db, id) : null;
}

export function finishWorkout(db: SqlExecutor, workoutId: string, now: string): Result<{ workoutId: string }> {
  try {
    return db.transaction(() => {
      const workout = requireWorkout(db, workoutId);
      if (workout.ended_at) return ok({ workoutId });
      db.run("UPDATE workout SET ended_at = ?, updated_at = ? WHERE id = ?", [now, now, workoutId]);
      return ok({ workoutId });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    return err("STORAGE_FAILURE");
  }
}

export function addExerciseToWorkout(
  db: SqlExecutor,
  input: { actionId: string; workoutId: string; exerciseId: string; now: string },
): Result<{ entryId: string }> {
  try {
    return db.transaction(() => {
      requireWorkout(db, input.workoutId);
      const exercise = requireExercise(db, input.exerciseId);
      const existing = db.get<{ id: string }>(
        `SELECT id FROM workout_exercise
         WHERE workout_id = ? AND exercise_id = ? AND deleted_at IS NULL`,
        [input.workoutId, exercise.id],
      );
      if (existing) return ok({ entryId: existing.id });
      const position = nextPosition(
        db,
        "SELECT COALESCE(MAX(position), 0) AS p FROM workout_exercise WHERE workout_id = ? AND deleted_at IS NULL",
        [input.workoutId],
      );
      db.run(
        `INSERT INTO workout_exercise (id, workout_id, exercise_id, position, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [input.actionId, input.workoutId, exercise.id, position, input.now, input.now],
      );
      return ok({ entryId: input.actionId });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    return err("STORAGE_FAILURE");
  }
}

export function confirmSet(db: SqlExecutor, draft: SetDraft): Result<{ setId: string }> {
  try {
    return db.transaction(() => {
      const workout = requireWorkout(db, draft.workoutId);
      const exercise = requireExercise(db, draft.exerciseId);
      const stored = storedFields(exercise, draft);
      const entry = db.get<{ id: string }>(
        `SELECT id FROM workout_exercise
         WHERE workout_id = ? AND exercise_id = ? AND deleted_at IS NULL`,
        [workout.id, exercise.id],
      );
      if (!entry) fail("NOT_FOUND", { entry: "Add the exercise before logging a set" });
      const existing = db.get<SetRow>("SELECT * FROM workout_set WHERE id = ?", [draft.actionId]);
      if (existing) {
        if (existing.workout_exercise_id !== entry.id || existing.deleted_at || !sameStored(existing, stored)) fail("ACTION_CONFLICT");
        return ok({ setId: existing.id });
      }
      const position = nextPosition(
        db,
        "SELECT COALESCE(MAX(position), 0) AS p FROM workout_set WHERE workout_exercise_id = ? AND deleted_at IS NULL",
        [entry.id],
      );
      db.run(
        `INSERT INTO workout_set
          (id, workout_exercise_id, position, load_lb, reps, duration_sec, assisted, note, logged_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          draft.actionId,
          entry.id,
          position,
          stored.loadLb,
          stored.reps,
          stored.durationSec,
          stored.assisted,
          stored.note,
          draft.now,
          draft.now,
          draft.now,
        ],
      );
      return ok({ setId: draft.actionId });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    return err("STORAGE_FAILURE");
  }
}

export function updateSet(
  db: SqlExecutor,
  input: { setId: string; now: string } & Omit<SetDraft, "actionId" | "workoutId">,
): Result<{ setId: string }> {
  try {
    return db.transaction(() => {
      const row = db.get<SetRow & { exercise_id: string; workout_id: string }>(
        `SELECT s.*, we.exercise_id, we.workout_id
         FROM workout_set s
         JOIN workout_exercise we ON we.id = s.workout_exercise_id
         WHERE s.id = ? AND s.deleted_at IS NULL AND we.deleted_at IS NULL`,
        [input.setId],
      );
      if (!row) fail("NOT_FOUND");
      const exercise = requireExercise(db, row.exercise_id);
      const stored = storedFields(exercise, input);
      db.run(
        `UPDATE workout_set
         SET load_lb = ?, reps = ?, duration_sec = ?, assisted = ?, note = ?, updated_at = ?
         WHERE id = ?`,
        [stored.loadLb, stored.reps, stored.durationSec, stored.assisted, stored.note, input.now, input.setId],
      );
      return ok({ setId: input.setId });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    return err("STORAGE_FAILURE");
  }
}

export function deleteSet(db: SqlExecutor, setId: string, now: string): Result<{ setId: string }> {
  try {
    return db.transaction(() => {
      const row = db.get<{ id: string }>("SELECT id FROM workout_set WHERE id = ? AND deleted_at IS NULL", [setId]);
      if (!row) fail("NOT_FOUND");
      db.run("UPDATE workout_set SET deleted_at = ?, updated_at = ? WHERE id = ?", [now, now, setId]);
      return ok({ setId });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.failure;
    return err("STORAGE_FAILURE");
  }
}

export function getWorkout(db: SqlExecutor, workoutId: string): WorkoutDetail | null {
  const workout = db.get<WorkoutRow>(
    "SELECT * FROM workout WHERE id = ? AND deleted_at IS NULL",
    [workoutId],
  );
  if (!workout) return null;
  const entries = db.all<EntryRow>(
    `SELECT we.id AS entry_id, we.position, e.id AS exercise_id, e.type, e.bar_weight_lb, n.display_name
     FROM workout_exercise we
     JOIN exercise e ON e.id = we.exercise_id
     JOIN exercise_name n ON n.exercise_id = e.id AND n.is_canonical = 1 AND n.deleted_at IS NULL
     WHERE we.workout_id = ? AND we.deleted_at IS NULL
     ORDER BY we.position, we.id`,
    [workoutId],
  );
  const sets = db.all<SetRow & { workout_exercise_id: string }>(
    `SELECT s.* FROM workout_set s
     JOIN workout_exercise we ON we.id = s.workout_exercise_id
     WHERE we.workout_id = ? AND we.deleted_at IS NULL AND s.deleted_at IS NULL
     ORDER BY s.position, s.id`,
    [workoutId],
  );
  return {
    workoutId: workout.id,
    date: workout.date,
    label: workout.label ?? "",
    startedAt: workout.started_at,
    endedAt: workout.ended_at,
    entries: entries.map((entry) => {
      const entrySets = sets.filter((set) => set.workout_exercise_id === entry.entry_id);
      return {
        entryId: entry.entry_id,
        exerciseId: entry.exercise_id,
        name: entry.display_name,
        type: entry.type,
        position: entry.position,
        barWeightLb: entry.bar_weight_lb,
        ...previousPerformance(db, workout, entry, entrySets),
        sets: entrySets.map(toStoredSet),
      };
    }),
  };
}

export function listHistory(db: SqlExecutor): HistoryItem[] {
  const rows = db.all<{
    id: string;
    date: string;
    label: string | null;
    started_at: string | null;
    ended_at: string | null;
    display_name: string | null;
    entry_pos: number | null;
    set_id: string | null;
  }>(
    `SELECT w.id, w.date, w.label, w.started_at, w.ended_at, n.display_name, we.position AS entry_pos, s.id AS set_id
     FROM workout w
     LEFT JOIN workout_exercise we ON we.workout_id = w.id AND we.deleted_at IS NULL
     LEFT JOIN exercise_name n ON n.exercise_id = we.exercise_id AND n.is_canonical = 1 AND n.deleted_at IS NULL
     LEFT JOIN workout_set s ON s.workout_exercise_id = we.id AND s.deleted_at IS NULL
     WHERE w.deleted_at IS NULL
     ORDER BY w.date DESC, COALESCE(w.started_at, '') DESC, w.created_at DESC, w.id DESC,
              we.position, s.position, s.id`,
  );
  const items: HistoryItem[] = [];
  for (const row of rows) {
    let item = items.find((candidate) => candidate.workoutId === row.id);
    if (!item) {
      item = {
        workoutId: row.id,
        date: row.date,
        label: row.label ?? "",
        endedAt: row.ended_at,
        startedAt: row.started_at,
        exerciseNames: [],
        setCount: 0,
      };
      items.push(item);
    }
    if (row.display_name && !item.exerciseNames.includes(row.display_name)) {
      item.exerciseNames.push(row.display_name);
    }
    if (row.set_id) item.setCount += 1;
  }
  return items;
}

type WorkoutRow = {
  id: string;
  date: string;
  label: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
};

type EntryRow = {
  entry_id: string;
  position: number;
  exercise_id: string;
  type: ExerciseType;
  bar_weight_lb: string | null;
  display_name: string;
};

type SetRow = {
  id: string;
  workout_exercise_id: string;
  position: number;
  load_lb: string | null;
  reps: number | null;
  duration_sec: number | null;
  assisted: number;
  note: string | null;
  deleted_at: string | null;
};

type StoredFields = {
  loadLb: string | null;
  reps: number | null;
  durationSec: number | null;
  assisted: number;
  note: string | null;
};

function requireWorkout(db: SqlExecutor, workoutId: string): WorkoutRow {
  const workout = db.get<WorkoutRow>("SELECT * FROM workout WHERE id = ? AND deleted_at IS NULL", [workoutId]);
  if (!workout) fail("NOT_FOUND");
  return workout;
}

function requireExercise(db: SqlExecutor, exerciseId: string): ExerciseRow {
  const exercise = db.get<ExerciseRow>(
    `SELECT e.id, e.type, e.bar_weight_lb, n.display_name
     FROM exercise e
     JOIN exercise_name n ON n.exercise_id = e.id AND n.is_canonical = 1 AND n.deleted_at IS NULL
     WHERE e.id = ? AND e.deleted_at IS NULL`,
    [exerciseId],
  );
  if (!exercise) fail("NOT_FOUND");
  return exercise;
}

function storedFields(exercise: ExerciseRow, draft: Omit<SetDraft, "actionId" | "workoutId" | "exerciseId">): StoredFields {
  const note = draft.note?.trim() ? draft.note.trim() : null;
  const assisted = draft.assisted ? 1 : 0;
  if (exercise.type === "duration") {
    if (!Number.isInteger(draft.durationSec) || (draft.durationSec ?? 0) < 1) {
      fail("INVALID_INPUT", { duration: "Enter a time" });
    }
    return { loadLb: null, reps: null, durationSec: draft.durationSec ?? null, assisted, note };
  }
  if (!Number.isInteger(draft.reps) || (draft.reps ?? 0) < 1) {
    fail("INVALID_INPUT", { reps: "Enter reps" });
  }
  if (exercise.type === "bodyweight") {
    return { loadLb: null, reps: draft.reps ?? null, durationSec: null, assisted, note };
  }
  let load: string | null = null;
  if (exercise.type === "barbell") {
    const hasTotal = draft.totalLb !== undefined && draft.totalLb.trim() !== "";
    const hasPlates = draft.platesLb !== undefined && draft.platesLb.trim() !== "";
    if (hasTotal === hasPlates) fail("INVALID_INPUT", { load: "Enter total weight or plates" });
    if (hasTotal) {
      if (parsePounds(draft.totalLb ?? "") === null || parsePounds(draft.totalLb ?? "") === 0) {
        fail("INVALID_INPUT", { load: "Enter the total weight" });
      }
      load = formatPounds(parsePounds(draft.totalLb ?? "") ?? 0);
    } else {
      const plates = parsePounds(draft.platesLb ?? "");
      if (plates === null) fail("INVALID_INPUT", { load: "Enter the plates" });
      const total = addPounds(draft.platesLb ?? "", exercise.bar_weight_lb ?? "45");
      if (total === null || parsePounds(total) === 0) fail("INVALID_INPUT", { load: "Enter the plates" });
      load = total;
    }
  } else {
    if (draft.totalLb === undefined || parsePounds(draft.totalLb) === null || parsePounds(draft.totalLb) === 0) {
      fail("INVALID_INPUT", { load: "Enter the weight" });
    }
    load = formatPounds(parsePounds(draft.totalLb ?? "") ?? 0);
  }
  return { loadLb: load, reps: draft.reps ?? null, durationSec: null, assisted, note };
}

function sameStored(existing: SetRow, stored: StoredFields): boolean {
  return (
    existing.load_lb === stored.loadLb &&
    existing.reps === stored.reps &&
    existing.duration_sec === stored.durationSec &&
    existing.assisted === stored.assisted &&
    (existing.note ?? null) === stored.note
  );
}

function nextPosition(db: SqlExecutor, sql: string, params: readonly unknown[]): number {
  const row = db.get<{ p: number }>(sql, params);
  return (row?.p ?? 0) + 1;
}

function toSummary(row: ExerciseRow): ExerciseSummary {
  return { exerciseId: row.id, name: row.display_name, type: row.type };
}

function toStoredSet(row: SetRow): StoredSet {
  return {
    setId: row.id,
    position: row.position,
    loadLb: row.load_lb,
    reps: row.reps,
    durationSec: row.duration_sec,
    assisted: row.assisted === 1,
    note: row.note,
    line: formatSetLine(row),
  };
}

export function formatSetLine(row: {
  load_lb: string | null;
  reps: number | null;
  duration_sec: number | null;
}): string {
  if (row.duration_sec != null) {
    const minutes = Math.floor(row.duration_sec / 60);
    const seconds = String(row.duration_sec % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }
  if (row.load_lb == null) return `${row.reps} reps`;
  return `${row.load_lb} lb × ${row.reps}`;
}

function previousPerformance(db: SqlExecutor, current: WorkoutRow, entry: EntryRow, currentSets: SetRow[]) {
  const rows = db.all<SetRow & {
    workout_id: string;
    date: string;
    started_at: string | null;
    ended_at: string | null;
    created_at: string;
  }>(
    `SELECT s.id, s.workout_exercise_id, s.position, s.load_lb, s.reps, s.duration_sec,
            s.assisted, s.note, s.deleted_at, w.id AS workout_id, w.date, w.started_at, w.ended_at, w.created_at
     FROM workout_set s
     JOIN workout_exercise we ON we.id = s.workout_exercise_id AND we.deleted_at IS NULL
     JOIN workout w ON w.id = we.workout_id AND w.deleted_at IS NULL
     WHERE we.exercise_id = ? AND s.deleted_at IS NULL AND w.id != ?
     ORDER BY w.date, COALESCE(w.started_at, ''), w.created_at, w.id, s.position, s.id`,
    [entry.exercise_id, current.id],
  );
  const currentKey = orderKey(current);
  const earlier = rows.filter((row) => orderKey(row) < currentKey);
  const latest = earlier.at(-1);
  const comparable = [...currentSets].reverse().find((row) => comparableSet(row, entry.type));
  const prior = comparable ? undefined : [...earlier].reverse().find((row) =>
    (row.ended_at || row.started_at === null) && comparableSet(row, entry.type));
  const lastComparableSet = comparable ? { set: toStoredSet(comparable), date: current.date, currentWorkout: true }
    : prior ? { set: toStoredSet(prior), date: prior.date, currentWorkout: false } : null;
  return {
    lastTimeHint: latest ? earlier.filter((row) => row.workout_id === latest.workout_id).map(formatSetLine).join(", ") : null,
    lastComparableSet,
  };
}

function comparableSet(row: SetRow, type: ExerciseType): boolean {
  if (type === "duration") return row.duration_sec !== null && row.duration_sec > 0;
  if (row.reps === null || row.reps < 1 || row.duration_sec !== null) return false;
  if (type === "bodyweight") return row.load_lb === null;
  const load = row.load_lb === null ? null : parsePounds(row.load_lb);
  return load !== null && load > 0;
}

function orderKey(row: { date: string; started_at: string | null; created_at: string; workout_id?: string; id?: string }): string {
  const id = row.workout_id ?? row.id ?? "";
  return `${row.date}\u0000${row.started_at ?? ""}\u0000${row.created_at}\u0000${id}`;
}
