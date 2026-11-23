import type { SqlExecutor } from "../storage/sql";
import { readTrainingProfile } from "./trainingProfile";
import { getOpenWorkout } from "./workout";
import { buildPersonalContext as buildCoreContext, type PersonalSnapshot, type PersonalContext, type PerformedSet } from "./personalContextCore";
import { sha256Hex } from "../shared/digest";
export { RECENT_DAY_WINDOW, MAX_RECENT_SESSIONS, MAX_SETS_PER_SESSION, MAX_BASELINES, MAX_GAPS, MAX_GAP_CHARS, MAX_PREFERENCES } from "./personalContextCore";
export type { PerformedSet, PlannedSet, PersonalSnapshot, PersonalContext } from "./personalContextCore";

export function buildPersonalContext(snapshot: PersonalSnapshot): PersonalContext {
  const context = buildCoreContext(snapshot);
  return { ...context, revision: sha256Hex(context.revision) };
}

export function personalContextFromDatabase(db: SqlExecutor, asOf: string, timeZone: string): PersonalContext {
  const open = getOpenWorkout(db);
  const rows = db.all<{
    id: string;
    exercise_id: string;
    display_name: string;
    type: PerformedSet["exerciseType"];
    workout_id: string;
    label: string | null;
    date: string;
    load_lb: string | null;
    reps: number | null;
    assisted: number;
    logged_at: string | null;
    ended_at: string | null;
    deleted_at: string | null;
  }>(
    `SELECT s.id, we.exercise_id, n.display_name, e.type, w.id AS workout_id, w.label, w.date,
            s.load_lb, s.reps, s.assisted, s.logged_at, w.ended_at, s.deleted_at
     FROM workout_set s
     JOIN workout_exercise we ON we.id = s.workout_exercise_id
     JOIN workout w ON w.id = we.workout_id AND w.deleted_at IS NULL
     JOIN exercise e ON e.id = we.exercise_id
     JOIN exercise_name n ON n.exercise_id = e.id AND n.is_canonical = 1 AND n.deleted_at IS NULL
     WHERE we.deleted_at IS NULL`,
  );
  return buildPersonalContext({
    asOf,
    timeZone,
    profile: readTrainingProfile(db),
    activeWorkout: open ? { id: open.workoutId, label: open.label, date: open.date } : null,
    plannedSets: [],
    performedSets: rows.map((row) => ({
      id: row.id,
      exerciseId: row.exercise_id,
      exerciseName: row.display_name,
      exerciseType: row.type,
      workoutId: row.workout_id,
      workoutLabel: row.label ?? "",
      date: row.date,
      loadLb: row.load_lb,
      reps: row.reps,
      assisted: row.assisted === 1,
      ended: row.ended_at !== null,
      deleted: row.deleted_at !== null,
      loggedAt: row.logged_at,
    })),
  });
}
