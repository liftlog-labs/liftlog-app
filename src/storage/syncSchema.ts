import type { SqlExecutor } from "./sql";

export const SYNC_TYPES = ["exercise", "exercise_name", "workout", "workout_exercise", "workout_set", "training_profile"] as const;
export type SyncType = typeof SYNC_TYPES[number];

// SQLite triggers make even single-statement domain writes atomic with their outbox entry.
const fields: Record<SyncType, string> = {
  exercise: "'type',NEW.type,'name',COALESCE((SELECT display_name FROM exercise_name WHERE exercise_id=NEW.id AND is_canonical=1 AND deleted_at IS NULL LIMIT 1),NEW.id),'barWeightLb',NEW.bar_weight_lb",
  exercise_name: "'exerciseId',NEW.exercise_id,'name',NEW.display_name,'canonical',json(CASE WHEN NEW.is_canonical=1 THEN 'true' ELSE 'false' END)",
  workout: "'date',NEW.date,'label',NEW.label,'startedAt',NEW.started_at,'endedAt',NEW.ended_at",
  workout_exercise: "'workoutId',NEW.workout_id,'exerciseId',NEW.exercise_id,'position',NEW.position",
  workout_set: "'workoutExerciseId',NEW.workout_exercise_id,'position',NEW.position,'loadLb',NEW.load_lb,'reps',NEW.reps,'durationSec',NEW.duration_sec,'assisted',json(CASE WHEN NEW.assisted=1 THEN 'true' ELSE 'false' END),'note',NEW.note,'loggedAt',NEW.logged_at",
  training_profile: "'goal',NEW.goal,'experience',NEW.experience,'trainingDays',NEW.training_days,'sessionMinutes',NEW.session_minutes,'equipment',json(NEW.equipment_json),'preferences',json(NEW.preferences_json)",
};

export function migrateSync(db: SqlExecutor): void {
  db.transaction(() => {
    db.exec(`
CREATE TABLE IF NOT EXISTS sync_state (
 id INTEGER PRIMARY KEY CHECK(id=1), account_id TEXT, origin TEXT,
 suppress INTEGER NOT NULL DEFAULT 0, cursor INTEGER NOT NULL DEFAULT 0,
 restored INTEGER NOT NULL DEFAULT 0, consent TEXT, terminal INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0, last_code TEXT, local_version INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO sync_state(id) VALUES(1);
CREATE TABLE IF NOT EXISTS sync_outbox (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT NOT NULL UNIQUE,
 record_type TEXT NOT NULL, client_id TEXT NOT NULL, kind TEXT NOT NULL,
 payload TEXT, base_revision INTEGER, fingerprint TEXT, blocked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sync_outbox_identity ON sync_outbox(record_type,client_id,seq);
CREATE TABLE IF NOT EXISTS sync_shadow (
 record_type TEXT NOT NULL, client_id TEXT NOT NULL, revision INTEGER NOT NULL,
 deleted INTEGER NOT NULL, payload TEXT, applied INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(record_type,client_id)
);
CREATE TABLE IF NOT EXISTS sync_conflict (
 id INTEGER PRIMARY KEY AUTOINCREMENT, record_type TEXT NOT NULL, client_id TEXT NOT NULL,
 reason TEXT NOT NULL, local_payload TEXT, remote_change TEXT NOT NULL,
 resolved INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sync_conflict_identity ON sync_conflict(record_type,client_id,resolved);
CREATE TABLE IF NOT EXISTS sync_association (source TEXT PRIMARY KEY, mapping TEXT NOT NULL);
`);
    for (const table of SYNC_TYPES) {
      for (const event of ["INSERT", "UPDATE"] as const) {
        const deleted = table === "training_profile" ? "0" : "NEW.deleted_at IS NOT NULL";
        db.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_${event.toLowerCase()} AFTER ${event} ON ${table}
WHEN (SELECT suppress=0 AND account_id IS NOT NULL FROM sync_state WHERE id=1)
BEGIN
 INSERT INTO sync_outbox(op_id,record_type,client_id,kind,payload)
 VALUES(lower(hex(randomblob(16))),'${table}',NEW.id,CASE WHEN ${deleted} THEN 'delete' ELSE 'upsert' END,
 CASE WHEN ${deleted} THEN NULL ELSE json_object(${fields[table]}) END);
 UPDATE sync_state SET local_version=local_version+1 WHERE id=1;
END;`);
      }
      const oldDeleted = table === "training_profile" ? "1" : "OLD.deleted_at IS NULL";
      db.exec(`CREATE TRIGGER IF NOT EXISTS sync_${table}_delete AFTER DELETE ON ${table}
WHEN (SELECT suppress=0 AND account_id IS NOT NULL FROM sync_state WHERE id=1) AND ${oldDeleted}
BEGIN
 INSERT INTO sync_outbox(op_id,record_type,client_id,kind,payload)
 VALUES(lower(hex(randomblob(16))),'${table}',OLD.id,'delete',NULL);
 UPDATE sync_state SET local_version=local_version+1 WHERE id=1;
END;`);
    }
    // Exercise names also form part of the exercise definition in the server contract.
    for (const event of ["INSERT", "UPDATE"] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS sync_canonical_${event.toLowerCase()} AFTER ${event} ON exercise_name
WHEN NEW.is_canonical=1 AND NEW.deleted_at IS NULL AND (SELECT suppress=0 AND account_id IS NOT NULL FROM sync_state WHERE id=1)
BEGIN
 INSERT INTO sync_outbox(op_id,record_type,client_id,kind,payload)
 SELECT lower(hex(randomblob(16))),'exercise',e.id,'upsert',json_object('type',e.type,'name',NEW.display_name,'barWeightLb',e.bar_weight_lb)
 FROM exercise e WHERE e.id=NEW.exercise_id AND e.deleted_at IS NULL;
END;`);
    }
    db.run("UPDATE schema_meta SET version=3 WHERE id=1 AND version<3");
  });
}
