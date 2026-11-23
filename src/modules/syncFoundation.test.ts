import assert from "node:assert/strict";
import test from "node:test";
import { migrate } from "../storage/schema";
import { openNodeDatabase } from "../storage/nodeDriver";
import { accountKeyForEmail, legacyDatabaseFile } from "./accountSession";
import { readTrainingProfile } from "./trainingProfile";
import { listHistory } from "./workout";
import { applyPull, type SyncChange } from "./syncApply";
import { attachmentForLogin, copyLegacyWorkspace, migrationComplete } from "./workspaceMigration";

const NOW = "2026-11-05T15:00:00.000Z";

function empty() {
  const db = openNodeDatabase();
  migrate(db, NOW);
  return db;
}

test("a fresh login does not attach a legacy email workspace, including after recreation", () => {
  const legacy = empty();
  const first = empty();
  const recreated = empty();
  legacy.run(
    `INSERT INTO workout (id, date, label, normalized_label, started_at, ended_at, created_at, updated_at)
     VALUES ('w-old', '2026-11-01', 'Old Day', 'old day', ?, ?, ?, ?)`,
    [NOW, NOW, NOW, NOW],
  );
  assert.equal(attachmentForLogin("fresh"), "separate");
  assert.equal(attachmentForLogin("continuous"), "copy");
  assert.equal(attachmentForLogin("explicit"), "copy");
  const email = "ada@example.com";
  assert.equal(legacyDatabaseFile(email).includes(accountKeyForEmail(email)), true);
  copyLegacyWorkspace(legacy, first, "account-original", accountKeyForEmail(email));
  copyLegacyWorkspace(legacy, first, "account-original", accountKeyForEmail(email));
  assert.equal(listHistory(first).filter((item) => item.label === "Old Day").length, 1);
  assert.equal(migrationComplete(first, "account-original"), true);
  assert.equal(migrationComplete(recreated, "account-recreated"), false);
  assert.equal(listHistory(recreated).some((item) => item.label === "Old Day"), false);
  assert.throws(() => copyLegacyWorkspace(legacy, first, "account-recreated", accountKeyForEmail(email)));
  assert.equal(listHistory(first).filter((item) => item.label === "Old Day").length, 1);
});

test("an initial pull restores one copy of the records and a second apply does not duplicate them", () => {
  const changes: SyncChange[] = [
    {
      cursor: 1,
      recordType: "exercise",
      clientId: "custom-press",
      serverRevision: 1,
      deleted: false,
      payload: { type: "machine", name: "Custom Press", barWeightLb: null },
    },
    {
      cursor: 2,
      recordType: "exercise_name",
      clientId: "custom-press-name",
      serverRevision: 1,
      deleted: false,
      payload: { exerciseId: "custom-press", name: "Custom Press", canonical: true },
    },
    {
      cursor: 3,
      recordType: "workout",
      clientId: "wo-1",
      serverRevision: 1,
      deleted: false,
      payload: { date: "2026-11-05", label: "Legs", startedAt: NOW, endedAt: NOW },
    },
    {
      cursor: 4,
      recordType: "workout_exercise",
      clientId: "en-1",
      serverRevision: 1,
      deleted: false,
      payload: { workoutId: "wo-1", exerciseId: "custom-press", position: 1 },
    },
    {
      cursor: 5,
      recordType: "workout_set",
      clientId: "set-1",
      serverRevision: 1,
      deleted: false,
      payload: { workoutExerciseId: "en-1", position: 1, loadLb: "100", reps: 5, durationSec: null, assisted: false, note: null, loggedAt: null },
    },
    {
      cursor: 6,
      recordType: "training_profile",
      clientId: "local",
      serverRevision: 2,
      deleted: false,
      payload: { goal: "hypertrophy", experience: null, trainingDays: 4, sessionMinutes: null, equipment: ["machine"], preferences: null },
    },
  ];
  const db = empty();
  applyPull(db, changes, NOW);
  applyPull(db, changes, NOW);
  assert.equal(listHistory(db).length, 1);
  assert.equal(listHistory(db)[0]?.label, "Legs");
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM workout_set WHERE deleted_at IS NULL")?.c, 1);
  assert.equal(db.get<{ load_lb: string }>("SELECT load_lb FROM workout_set WHERE id = 'set-1'")?.load_lb, "100");
  assert.equal(readTrainingProfile(db).goal, "hypertrophy");
  applyPull(db, [{ cursor: 7, recordType: "workout_set", clientId: "set-1", serverRevision: 2, deleted: true, payload: null }], NOW);
  assert.equal(db.get<{ c: number }>("SELECT COUNT(*) AS c FROM workout_set WHERE deleted_at IS NULL")?.c, 0);
  assert.equal(db.get<{ load_lb: string }>("SELECT load_lb FROM workout_set WHERE id = 'set-1'")?.load_lb, "100");
});
