import { isSecretPreferenceKey } from "./accountSession";
import type { SqlExecutor } from "../storage/sql";

const STATE = "workspace_migration";
const BOUND = "workspace_bound_account";
const FROM = "workspace_migrated_from";
const DECLINED = "legacy_workspace_declined";

const TABLES = [
  "exercise",
  "exercise_name",
  "workout",
  "workout_exercise",
  "workout_set",
] as const;

export function attachmentForLogin(kind: "continuous" | "fresh" | "explicit"): "copy" | "separate" {
  return kind === "fresh" ? "separate" : "copy";
}

export function migrationComplete(db: SqlExecutor, accountId: string): boolean {
  return preference(db, STATE) === "complete" && preference(db, BOUND) === accountId;
}

export function legacyChoiceDeclined(db: SqlExecutor, legacyKey: string): boolean {
  return preference(db, DECLINED) === legacyKey;
}

export function declineLegacyWorkspace(db: SqlExecutor, legacyKey: string): void {
  setPreference(db, DECLINED, legacyKey);
}

export function copyLegacyWorkspace(legacy: SqlExecutor, target: SqlExecutor, accountId: string, legacyKey: string): void {
  if (migrationComplete(target, accountId)) return;
  const bound = preference(target, BOUND);
  if (bound && bound !== accountId) {
    throw new Error("workspace bound to another account");
  }
  const copies = TABLES.map((table) => ({
    table,
    columns: columns(legacy, table),
    rows: legacy.all<Record<string, unknown>>(`SELECT * FROM ${table}`),
  }));
  const profiles = legacy.all<Record<string, unknown>>("SELECT * FROM training_profile");
  const preferences = legacy.all<{ key: string; value: string }>("SELECT key, value FROM preference ORDER BY key");
  target.transaction(() => {
    if (migrationComplete(target, accountId)) return;
    for (const copy of copies) {
      for (const row of copy.rows) {
        const names = copy.columns.join(", ");
        const marks = copy.columns.map(() => "?").join(", ");
        target.run(
          `INSERT OR IGNORE INTO ${copy.table} (${names}) VALUES (${marks})`,
          copy.columns.map((column) => row[column]),
        );
      }
    }
    const existingProfile = target.get<{ id: string }>("SELECT id FROM training_profile WHERE id = 'local'");
    if (!existingProfile) {
      for (const row of profiles) {
        target.run(
          `INSERT INTO training_profile
            (id, goal, experience, training_days, session_minutes, equipment_json, preferences_json, updated_at, revision)
           VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
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
    }
    for (const row of preferences) {
      if (isSecretPreferenceKey(row.key) || row.key === STATE || row.key === BOUND || row.key === FROM || row.key === DECLINED) continue;
      target.run("INSERT OR IGNORE INTO preference (key, value) VALUES (?, ?)", [row.key, row.value]);
    }
    setPreference(target, BOUND, accountId);
    setPreference(target, FROM, legacyKey);
    setPreference(target, STATE, "complete");
  });
}

function columns(db: SqlExecutor, table: string): string[] {
  return db.all<{ name: string }>(`PRAGMA table_info(${table})`).map((column) => column.name);
}

function preference(db: SqlExecutor, key: string): string | null {
  return db.get<{ value: string }>("SELECT value FROM preference WHERE key = ?", [key])?.value ?? null;
}

function setPreference(db: SqlExecutor, key: string, value: string): void {
  db.run(
    `INSERT INTO preference (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}
