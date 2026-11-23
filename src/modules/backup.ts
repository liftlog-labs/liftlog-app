import { isSecretPreferenceKey } from "./accountSession";
import { err, ok, type Result } from "../shared/result";
import type { SqlExecutor } from "../storage/sql";

export type CompleteBackup = {
  kind: "liftlog.complete-backup";
  format_version: 1;
  exported_at: string;
  workspace?: string;
  counts: {
    exercises: number;
    exerciseNames: number;
    workouts: number;
    workoutExercises: number;
    workoutSets: number;
    preferences: number;
    trainingProfiles?: number;
  };
  records: {
    exercises: ExerciseRecord[];
    exerciseNames: ExerciseNameRecord[];
    workouts: WorkoutRecord[];
    workoutExercises: WorkoutExerciseRecord[];
    workoutSets: WorkoutSetRecord[];
    trainingProfiles?: TrainingProfileRecord[];
  };
  preferences: PreferenceRecord[];
};

type ExerciseRecord = {
  id: string;
  type: string;
  bar_weight_lb: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type ExerciseNameRecord = {
  id: string;
  exercise_id: string;
  display_name: string;
  normalized_name: string;
  is_canonical: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type WorkoutRecord = {
  id: string;
  date: string;
  label: string | null;
  normalized_label: string | null;
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type WorkoutExerciseRecord = {
  id: string;
  workout_id: string;
  exercise_id: string;
  position: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type WorkoutSetRecord = {
  id: string;
  workout_exercise_id: string;
  position: number;
  load_lb: string | null;
  reps: number | null;
  duration_sec: number | null;
  assisted: number;
  note: string | null;
  logged_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type PreferenceRecord = { key: string; value: string };

type TrainingProfileRecord = {
  id: "local";
  goal: string | null;
  experience: string | null;
  training_days: number | null;
  session_minutes: number | null;
  equipment_json: string | null;
  preferences_json: string | null;
  updated_at: string;
  revision: number;
};

export type BackupPreview = {
  exportedAt: string;
  counts: CompleteBackup["counts"];
  workspace: string | null;
};

export interface TextFileStore {
  write(name: string, contents: string): void;
  read(name: string): string;
}

const SAFETY_NAME = "liftlog-safety-backup.json";

export function exportBackup(db: SqlExecutor, now: string, workspace?: string): CompleteBackup {
  const records = {
    exercises: db.all<ExerciseRecord>("SELECT id, type, bar_weight_lb, created_at, updated_at, deleted_at FROM exercise ORDER BY id"),
    exerciseNames: db.all<ExerciseNameRecord>(
      `SELECT id, exercise_id, display_name, normalized_name, is_canonical, created_at, updated_at, deleted_at
       FROM exercise_name ORDER BY id`,
    ),
    workouts: db.all<WorkoutRecord>(
      `SELECT id, date, label, normalized_label, started_at, ended_at, created_at, updated_at, deleted_at
       FROM workout ORDER BY id`,
    ),
    workoutExercises: db.all<WorkoutExerciseRecord>(
      `SELECT id, workout_id, exercise_id, position, created_at, updated_at, deleted_at
       FROM workout_exercise ORDER BY id`,
    ),
    workoutSets: db.all<WorkoutSetRecord>(
      `SELECT id, workout_exercise_id, position, load_lb, reps, duration_sec, assisted, note, logged_at, created_at, updated_at, deleted_at
       FROM workout_set ORDER BY id`,
    ),
  };
  const preferences = db
    .all<PreferenceRecord>("SELECT key, value FROM preference ORDER BY key")
    .filter((row) => !isSecretPreferenceKey(row.key) && !isWorkspaceMetadata(row.key));
  const trainingProfiles = db.all<TrainingProfileRecord>(
    `SELECT id, goal, experience, training_days, session_minutes, equipment_json, preferences_json, updated_at, revision
     FROM training_profile ORDER BY id`,
  );
  return {
    kind: "liftlog.complete-backup",
    format_version: 1,
    exported_at: now,
    counts: {
      exercises: records.exercises.length,
      exerciseNames: records.exerciseNames.length,
      workouts: records.workouts.length,
      workoutExercises: records.workoutExercises.length,
      workoutSets: records.workoutSets.length,
      preferences: preferences.length,
      trainingProfiles: trainingProfiles.length,
    },
    records: { ...records, trainingProfiles },
    preferences,
    ...(workspace ? { workspace } : {}),
  };
}

export function inspectBackup(value: unknown): Result<BackupPreview> {
  const parsed = parseBackup(value);
  if (!parsed.ok) return parsed;
  return ok({ exportedAt: parsed.value.exported_at, counts: parsed.value.counts, workspace: parsed.value.workspace ?? null });
}

export function restoreBackup(
  db: SqlExecutor,
  files: TextFileStore,
  raw: string,
  now: string,
  expectedWorkspace?: string,
): Result<{ safetyName: string }> {
  if (accountBacked(db)) return err("WORKSPACE_MISMATCH");
  let candidate: CompleteBackup;
  try {
    candidate = JSON.parse(raw) as CompleteBackup;
  } catch {
    return err("INVALID_BACKUP");
  }
  const inspected = parseBackup(candidate);
  if (!inspected.ok) return inspected;
  if (expectedWorkspace && inspected.value.workspace && inspected.value.workspace !== expectedWorkspace) {
    return err("WORKSPACE_MISMATCH");
  }

  let safety: CompleteBackup;
  try {
    safety = exportBackup(db, now);
    const encoded = JSON.stringify(safety);
    files.write(SAFETY_NAME, encoded);
    const reread = parseBackup(JSON.parse(files.read(SAFETY_NAME)));
    if (!reread.ok) return err("STORAGE_FAILURE");
  } catch {
    return err("STORAGE_FAILURE");
  }

  try {
    applyBackup(db, candidate);
  } catch {
    return err("STORAGE_FAILURE");
  }
  return ok({ safetyName: SAFETY_NAME });
}

export function applyBackup(db: SqlExecutor, backup: CompleteBackup): void {
  if (accountBacked(db)) throw new Error("Account history cannot be replaced by a file backup");
  db.transaction(() => {
    db.run("DELETE FROM workout_set");
    db.run("DELETE FROM workout_exercise");
    db.run("DELETE FROM workout");
    db.run("DELETE FROM exercise_name");
    db.run("DELETE FROM exercise");
    db.run("DELETE FROM preference");
    for (const row of backup.records.exercises) {
      db.run(
        `INSERT INTO exercise (id, type, bar_weight_lb, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [row.id, row.type, row.bar_weight_lb, row.created_at, row.updated_at, row.deleted_at],
      );
    }
    for (const row of backup.records.exerciseNames) {
      db.run(
        `INSERT INTO exercise_name
          (id, exercise_id, display_name, normalized_name, is_canonical, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.exercise_id,
          row.display_name,
          row.normalized_name,
          row.is_canonical,
          row.created_at,
          row.updated_at,
          row.deleted_at,
        ],
      );
    }
    for (const row of backup.records.workouts) {
      db.run(
        `INSERT INTO workout
          (id, date, label, normalized_label, started_at, ended_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.date,
          row.label,
          row.normalized_label,
          row.started_at,
          row.ended_at,
          row.created_at,
          row.updated_at,
          row.deleted_at,
        ],
      );
    }
    for (const row of backup.records.workoutExercises) {
      db.run(
        `INSERT INTO workout_exercise (id, workout_id, exercise_id, position, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.id, row.workout_id, row.exercise_id, row.position, row.created_at, row.updated_at, row.deleted_at],
      );
    }
    for (const row of backup.records.workoutSets) {
      db.run(
        `INSERT INTO workout_set
          (id, workout_exercise_id, position, load_lb, reps, duration_sec, assisted, note, logged_at, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.workout_exercise_id,
          row.position,
          row.load_lb,
          row.reps,
          row.duration_sec,
          row.assisted,
          row.note,
          row.logged_at,
          row.created_at,
          row.updated_at,
          row.deleted_at,
        ],
      );
    }
    for (const row of backup.preferences) {
      if (isWorkspaceMetadata(row.key)) continue;
      db.run("INSERT INTO preference (key, value) VALUES (?, ?)", [row.key, row.value]);
    }
    db.run("DELETE FROM training_profile");
    for (const row of backup.records.trainingProfiles ?? []) {
      db.run(
        `INSERT INTO training_profile
          (id, goal, experience, training_days, session_minutes, equipment_json, preferences_json, updated_at, revision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.id,
          row.goal,
          row.experience,
          row.training_days,
          row.session_minutes,
          row.equipment_json,
          row.preferences_json,
          row.updated_at,
          row.revision,
        ],
      );
    }
  });
}

function parseBackup(value: unknown): Result<CompleteBackup> {
  if (!value || typeof value !== "object") return err("INVALID_BACKUP");
  const backup = value as Partial<CompleteBackup>;
  if (backup.kind !== "liftlog.complete-backup") return err("UNSUPPORTED_FORMAT");
  if (backup.format_version !== 1) return err("UNSUPPORTED_FORMAT");
  if (typeof backup.exported_at !== "string" || !backup.records || !backup.counts) return err("INVALID_BACKUP");
  const records = backup.records;
  const groups = [
    records.exercises,
    records.exerciseNames,
    records.workouts,
    records.workoutExercises,
    records.workoutSets,
  ];
  if (groups.some((group) => !Array.isArray(group)) || !Array.isArray(backup.preferences)) {
    return err("INVALID_BACKUP");
  }
  if (
    backup.counts.exercises !== records.exercises.length ||
    backup.counts.exerciseNames !== records.exerciseNames.length ||
    backup.counts.workouts !== records.workouts.length ||
    backup.counts.workoutExercises !== records.workoutExercises.length ||
    backup.counts.workoutSets !== records.workoutSets.length ||
    backup.counts.preferences !== backup.preferences.length
  ) {
    return err("INVALID_BACKUP");
  }
  const exerciseIds = new Set(records.exercises.map((row) => row.id));
  const entryIds = new Set(records.workoutExercises.map((row) => row.id));
  const workoutIds = new Set(records.workouts.map((row) => row.id));
  for (const name of records.exerciseNames) {
    if (!exerciseIds.has(name.exercise_id)) return err("INVALID_BACKUP");
  }
  for (const entry of records.workoutExercises) {
    if (!workoutIds.has(entry.workout_id) || !exerciseIds.has(entry.exercise_id)) return err("INVALID_BACKUP");
  }
  for (const set of records.workoutSets) {
    if (!entryIds.has(set.workout_exercise_id)) return err("INVALID_BACKUP");
  }
  if (records.trainingProfiles !== undefined && !Array.isArray(records.trainingProfiles)) return err("INVALID_BACKUP");
  if (backup.workspace !== undefined && typeof backup.workspace !== "string") return err("INVALID_BACKUP");
  if (backup.preferences.some((row) => isSecretPreferenceKey(row.key))) return err("INVALID_BACKUP");
  const trainingProfiles = records.trainingProfiles ?? [];
  if (backup.counts.trainingProfiles !== undefined && backup.counts.trainingProfiles !== trainingProfiles.length) {
    return err("INVALID_BACKUP");
  }
  const normalized = {
    ...backup,
    records: { ...records, trainingProfiles },
    counts: { ...backup.counts, trainingProfiles: trainingProfiles.length },
  };
  return ok(normalized as CompleteBackup);
}

export function memoryFiles(): TextFileStore {
  const files = new Map<string, string>();
  return {
    write(name, contents) {
      files.set(name, contents);
    },
    read(name) {
      const contents = files.get(name);
      if (contents === undefined) throw new Error(`Missing ${name}`);
      return contents;
    },
  };
}

function isWorkspaceMetadata(key: string): boolean { return /^(workspace_|legacy_workspace_|sync_|cloud_|ai_|analytics_)/.test(key); }
function accountBacked(db: SqlExecutor): boolean {
  return !!db.get<{account_id:string|null}>("SELECT account_id FROM sync_state WHERE id=1")?.account_id || !!db.get("SELECT value FROM preference WHERE key='workspace_bound_account'");
}
