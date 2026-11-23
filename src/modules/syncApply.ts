import { normalizeName } from "../shared/names";
import type { SqlExecutor } from "../storage/sql";

export type SyncChange = {
  cursor: number;
  recordType: "exercise" | "exercise_name" | "workout" | "workout_exercise" | "workout_set" | "training_profile";
  clientId: string;
  serverRevision: number;
  deleted: boolean;
  payload: Record<string, unknown> | null;
};

export function applyPull(db: SqlExecutor, changes: SyncChange[], now: string): void {
  const ordered = [...changes].sort((left, right) => left.cursor - right.cursor || left.clientId.localeCompare(right.clientId));
  db.transaction(() => {
    for (const change of ordered) applyChange(db, change, now);
  });
}

export function applyChange(db: SqlExecutor, change: SyncChange, now: string): void {
  if (change.deleted) {
    markDeleted(db, change, now);
    return;
  }
  const payload = change.payload ?? {};
  if (change.recordType === "exercise") {
    db.run(
      `INSERT INTO exercise (id, type, bar_weight_lb, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, bar_weight_lb = excluded.bar_weight_lb, updated_at = excluded.updated_at, deleted_at = NULL`,
      [change.clientId, payload.type, payload.barWeightLb ?? null, now, now],
    );
  } else if (change.recordType === "exercise_name") {
    const name = String(payload.name ?? "");
    db.run(
      `INSERT INTO exercise_name
        (id, exercise_id, display_name, normalized_name, is_canonical, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
        exercise_id = excluded.exercise_id, display_name = excluded.display_name, normalized_name = excluded.normalized_name,
        is_canonical = excluded.is_canonical, updated_at = excluded.updated_at, deleted_at = NULL`,
      [change.clientId, payload.exerciseId, name, normalizeName(name), payload.canonical ? 1 : 0, now, now],
    );
  } else if (change.recordType === "workout") {
    const label = typeof payload.label === "string" ? payload.label : null;
    db.run(
      `INSERT INTO workout
        (id, date, label, normalized_label, started_at, ended_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
        date = excluded.date, label = excluded.label, normalized_label = excluded.normalized_label,
        started_at = excluded.started_at, ended_at = excluded.ended_at, updated_at = excluded.updated_at, deleted_at = NULL`,
      [change.clientId, payload.date, label, label ? normalizeName(label) : null, payload.startedAt ?? null, payload.endedAt ?? null, now, now],
    );
  } else if (change.recordType === "workout_exercise") {
    db.run(
      `INSERT INTO workout_exercise (id, workout_id, exercise_id, position, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
        workout_id = excluded.workout_id, exercise_id = excluded.exercise_id, position = excluded.position,
        updated_at = excluded.updated_at, deleted_at = NULL`,
      [change.clientId, payload.workoutId, payload.exerciseId, payload.position, now, now],
    );
  } else if (change.recordType === "workout_set") {
    db.run(
      `INSERT INTO workout_set
        (id, workout_exercise_id, position, load_lb, reps, duration_sec, assisted, note, logged_at, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
        workout_exercise_id = excluded.workout_exercise_id, position = excluded.position, load_lb = excluded.load_lb,
        reps = excluded.reps, duration_sec = excluded.duration_sec, assisted = excluded.assisted, note = excluded.note,
        logged_at = excluded.logged_at, updated_at = excluded.updated_at, deleted_at = NULL`,
      [
        change.clientId,
        payload.workoutExerciseId,
        payload.position,
        payload.loadLb ?? null,
        payload.reps ?? null,
        payload.durationSec ?? null,
        payload.assisted ? 1 : 0,
        payload.note ?? null,
        payload.loggedAt ?? null,
        now,
        now,
      ],
    );
  } else if (change.recordType === "training_profile") {
    db.run(
      `INSERT INTO training_profile
        (id, goal, experience, training_days, session_minutes, equipment_json, preferences_json, updated_at, revision)
       VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
        goal = excluded.goal, experience = excluded.experience, training_days = excluded.training_days,
        session_minutes = excluded.session_minutes, equipment_json = excluded.equipment_json,
        preferences_json = excluded.preferences_json, updated_at = excluded.updated_at, revision = excluded.revision`,
      [
        payload.goal ?? null,
        payload.experience ?? null,
        payload.trainingDays ?? null,
        payload.sessionMinutes ?? null,
        payload.equipment == null ? null : JSON.stringify(payload.equipment),
        payload.preferences == null ? null : JSON.stringify(payload.preferences),
        now,
        change.serverRevision,
      ],
    );
  }
}

function markDeleted(db: SqlExecutor, change: SyncChange, now: string): void {
  const tables: Record<string, string> = {
    exercise: "exercise",
    exercise_name: "exercise_name",
    workout: "workout",
    workout_exercise: "workout_exercise",
    workout_set: "workout_set",
  };
  const table = tables[change.recordType];
  if (!table) {
    if (change.recordType === "training_profile") db.run("DELETE FROM training_profile WHERE id = 'local'");
    return;
  }
  db.run(`UPDATE ${table} SET deleted_at = ?, updated_at = ? WHERE id = ?`, [now, now, change.clientId]);
}
