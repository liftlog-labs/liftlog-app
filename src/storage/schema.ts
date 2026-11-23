import type { SqlExecutor } from "./sql";
import { migrateSync } from "./syncSchema";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS exercise (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('barbell','dumbbell','machine','bodyweight','duration')),
  bar_weight_lb TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS exercise_name (
  id TEXT PRIMARY KEY,
  exercise_id TEXT NOT NULL REFERENCES exercise(id),
  display_name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  is_canonical INTEGER NOT NULL CHECK (is_canonical IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS exercise_name_active
  ON exercise_name(normalized_name) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS workout (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  label TEXT,
  normalized_label TEXT,
  started_at TEXT,
  ended_at TEXT,
  live_key INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_live_workout
  ON workout(live_key)
  WHERE deleted_at IS NULL AND ended_at IS NULL AND started_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS workout_exercise (
  id TEXT PRIMARY KEY,
  workout_id TEXT NOT NULL REFERENCES workout(id),
  exercise_id TEXT NOT NULL REFERENCES exercise(id),
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_exercise_entry
  ON workout_exercise(workout_id, exercise_id) WHERE deleted_at IS NULL;
CREATE TABLE IF NOT EXISTS workout_set (
  id TEXT PRIMARY KEY,
  workout_exercise_id TEXT NOT NULL REFERENCES workout_exercise(id),
  position INTEGER NOT NULL,
  load_lb TEXT,
  reps INTEGER,
  duration_sec INTEGER,
  assisted INTEGER NOT NULL DEFAULT 0 CHECK (assisted IN (0, 1)),
  note TEXT,
  logged_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS preference (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS training_profile (
  id TEXT PRIMARY KEY CHECK (id = 'local'),
  goal TEXT,
  experience TEXT,
  training_days INTEGER,
  session_minutes INTEGER,
  equipment_json TEXT,
  preferences_json TEXT,
  updated_at TEXT NOT NULL,
  revision INTEGER NOT NULL
);
`;

export const SEED: readonly { id: string; name: string; type: string; bar: string | null }[] = [
  { id: "seed-squat", name: "Barbell Back Squat", type: "barbell", bar: "45" },
  { id: "seed-bench", name: "Barbell Bench Press", type: "barbell", bar: "45" },
  { id: "seed-deadlift", name: "Conventional Deadlift", type: "barbell", bar: "45" },
  { id: "seed-row", name: "Dumbbell Row", type: "dumbbell", bar: null },
  { id: "seed-pulldown", name: "Lat Pulldown", type: "machine", bar: null },
  { id: "seed-leg-press", name: "Leg Press", type: "machine", bar: null },
  { id: "seed-pushup", name: "Push-up", type: "bodyweight", bar: null },
  { id: "seed-plank", name: "Plank", type: "duration", bar: null },
];

export function migrate(db: SqlExecutor, now = "2026-11-03T00:00:00.000Z"): void {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  const version = db.get<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1");
  if (!version) {
    db.run("INSERT INTO schema_meta (id, version) VALUES (1, 2)");
  } else if (version.version < 2) {
    db.run("UPDATE schema_meta SET version = 2 WHERE id = 1");
  }
  const count = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM exercise");
  if ((count?.c ?? 0) === 0) {
    for (const exercise of SEED) {
      db.run(
        `INSERT INTO exercise (id, type, bar_weight_lb, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
        [exercise.id, exercise.type, exercise.bar, now, now],
      );
      db.run(
        `INSERT INTO exercise_name
          (id, exercise_id, display_name, normalized_name, is_canonical, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        [
          `${exercise.id}-name`,
          exercise.id,
          exercise.name,
          exercise.name.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US"),
          now,
          now,
        ],
      );
    }
  }
  migrateSync(db);
}
