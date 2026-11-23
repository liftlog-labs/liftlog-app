import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { applyBackup, exportBackup, memoryFiles, restoreBackup } from "./backup";
import { migrate } from "../storage/schema";
import { openNodeDatabase } from "../storage/nodeDriver";
import {
  addExerciseToWorkout,
  confirmSet,
  createExercise,
  deleteSet,
  finishWorkout,
  getOpenWorkout,
  getWorkout,
  listHistory,
  searchExercises,
  browseExercises,
  startWorkout,
  updateSet,
} from "./workout";
import { afterSaveAttempt } from "../ui/saveState";
import { buildTrendRequest, requestTrends } from "./trends";

const NOW = "2026-11-03T15:00:00.000Z";
const EARLIER = "2026-11-01T15:00:00.000Z";

function db() {
  const database = openNodeDatabase();
  migrate(database, NOW);
  return database;
}

test("rolls back a failed transaction and reads many rows", () => {
  const database = db();
  assert.throws(() =>
    database.transaction(() => {
      database.run(
        "INSERT INTO exercise (id, type, created_at, updated_at) VALUES ('x', 'barbell', ?, ?)",
        [NOW, NOW],
      );
      throw new Error("fail");
    }),
  );
  assert.equal(database.get<{ c: number }>("SELECT COUNT(*) AS c FROM exercise WHERE id = 'x'")?.c, 0);
  const names = database.all<{ display_name: string }>("SELECT display_name FROM exercise_name ORDER BY display_name");
  assert.ok(names.length >= 8);
});

test("starts, resumes, and refuses a second live workout", () => {
  const database = db();
  const started = startWorkout(database, {
    actionId: "w1",
    label: "Leg Day",
    now: NOW,
    localDate: "2026-11-03",
  });
  assert.equal(started.ok && started.value.workoutId, "w1");
  assert.equal(getOpenWorkout(database)?.label, "Leg Day");
  const second = startWorkout(database, {
    actionId: "w2",
    label: "Push",
    now: NOW,
    localDate: "2026-11-03",
  });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.code, "LIVE_WORKOUT_EXISTS");
  assert.equal(finishWorkout(database, "w1", NOW).ok, true);
  assert.equal(getOpenWorkout(database), null);
});

test("keeps one exercise entry and stores each exercise type", () => {
  const database = db();
  startWorkout(database, { actionId: "w1", label: "Mixed", now: NOW, localDate: "2026-11-03" });
  const bench = addExerciseToWorkout(database, {
    actionId: "e1",
    workoutId: "w1",
    exerciseId: "seed-bench",
    now: NOW,
  });
  const again = addExerciseToWorkout(database, {
    actionId: "e1b",
    workoutId: "w1",
    exerciseId: "seed-bench",
    now: NOW,
  });
  assert.equal(bench.ok, true);
  assert.equal(again.ok, true);
  if (bench.ok && again.ok) assert.equal(bench.value.entryId, again.value.entryId);

  const plates = confirmSet(database, {
    actionId: "s-plates",
    workoutId: "w1",
    exerciseId: "seed-bench",
    platesLb: "90",
    reps: 5,
    assisted: false,
    note: null,
    now: NOW,
  });
  assert.equal(plates.ok, true);
  const total = confirmSet(database, {
    actionId: "s-total",
    workoutId: "w1",
    exerciseId: "seed-bench",
    totalLb: "135",
    reps: 3,
    assisted: false,
    note: null,
    now: NOW,
  });
  assert.equal(total.ok, true);

  addExerciseToWorkout(database, { actionId: "e2", workoutId: "w1", exerciseId: "seed-row", now: NOW });
  confirmSet(database, {
    actionId: "s-db",
    workoutId: "w1",
    exerciseId: "seed-row",
    totalLb: "50",
    reps: 8,
    assisted: false,
    note: null,
    now: NOW,
  });
  addExerciseToWorkout(database, { actionId: "e3", workoutId: "w1", exerciseId: "seed-leg-press", now: NOW });
  confirmSet(database, {
    actionId: "s-machine",
    workoutId: "w1",
    exerciseId: "seed-leg-press",
    totalLb: "100",
    reps: 10,
    assisted: true,
    note: null,
    now: NOW,
  });
  addExerciseToWorkout(database, { actionId: "e4", workoutId: "w1", exerciseId: "seed-pushup", now: NOW });
  confirmSet(database, {
    actionId: "s-bw",
    workoutId: "w1",
    exerciseId: "seed-pushup",
    reps: 12,
    assisted: false,
    note: null,
    now: NOW,
  });
  addExerciseToWorkout(database, { actionId: "e5", workoutId: "w1", exerciseId: "seed-plank", now: NOW });
  confirmSet(database, {
    actionId: "s-time",
    workoutId: "w1",
    exerciseId: "seed-plank",
    durationSec: 90,
    assisted: false,
    note: null,
    now: NOW,
  });

  const detail = getWorkout(database, "w1");
  const byName = Object.fromEntries((detail?.entries ?? []).map((entry) => [entry.name, entry.sets.map((set) => set.line)]));
  assert.deepEqual(byName["Barbell Bench Press"], ["135 lb × 5", "135 lb × 3"]);
  assert.deepEqual(byName["Dumbbell Row"], ["50 lb × 8"]);
  assert.deepEqual(byName["Leg Press"], ["100 lb × 10"]);
  assert.deepEqual(byName["Push-up"], ["12 reps"]);
  assert.deepEqual(byName["Plank"], ["1:30"]);

  const retry = confirmSet(database, {
    actionId: "s-plates",
    workoutId: "w1",
    exerciseId: "seed-bench",
    platesLb: "90",
    reps: 5,
    assisted: false,
    note: null,
    now: NOW,
  });
  assert.equal(retry.ok, true);
  assert.equal(getWorkout(database, "w1")?.entries[0].sets.length, 2);
});

test("edits and deletes a set and keeps a failed draft", () => {
  const database = db();
  startWorkout(database, { actionId: "w1", label: "Legs", now: NOW, localDate: "2026-11-03" });
  addExerciseToWorkout(database, { actionId: "e1", workoutId: "w1", exerciseId: "seed-squat", now: NOW });
  const draft = { totalLb: "185", reps: 5, assisted: false, note: null };
  confirmSet(database, { ...draft, actionId: "s1", workoutId: "w1", exerciseId: "seed-squat", now: NOW });
  const updated = updateSet(database, {
    setId: "s1",
    exerciseId: "seed-squat",
    totalLb: "205",
    reps: 3,
    assisted: false,
    note: null,
    now: NOW,
  });
  assert.equal(updated.ok, true);
  assert.equal(getWorkout(database, "w1")?.entries[0].sets[0].line, "205 lb × 3");
  assert.equal(deleteSet(database, "s1", NOW).ok, true);
  assert.equal(getWorkout(database, "w1")?.entries[0].sets.length, 0);

  const failed = afterSaveAttempt(draft, { ok: false, code: "STORAGE_FAILURE" });
  assert.equal(failed.clearInputs, false);
  assert.equal(failed.draft.totalLb, "185");
  assert.equal(failed.message, "Set not saved. Try again.");
  const saved = afterSaveAttempt(draft, { ok: true, value: { setId: "s2" } });
  assert.equal(saved.phase, "saved");
  assert.equal(saved.clearInputs, true);
});

test("reopens the same live workout and shows the last-time hint", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "liftlog-"));
  const file = path.join(directory, "liftlog.db");
  const first = openNodeDatabase(file);
  migrate(first, EARLIER);
  startWorkout(first, { actionId: "w-old", label: "Leg Day", now: EARLIER, localDate: "2026-11-01" });
  addExerciseToWorkout(first, { actionId: "e-old", workoutId: "w-old", exerciseId: "seed-squat", now: EARLIER });
  confirmSet(first, {
    actionId: "s-old",
    workoutId: "w-old",
    exerciseId: "seed-squat",
    totalLb: "185",
    reps: 5,
    assisted: false,
    note: null,
    now: EARLIER,
  });
  finishWorkout(first, "w-old", EARLIER);
  startWorkout(first, { actionId: "w-new", label: "Leg Day", now: NOW, localDate: "2026-11-03" });
  addExerciseToWorkout(first, { actionId: "e-new", workoutId: "w-new", exerciseId: "seed-squat", now: NOW });
  first.close();

  const reopened = openNodeDatabase(file);
  migrate(reopened, NOW);
  const open = getOpenWorkout(reopened);
  assert.equal(open?.workoutId, "w-new");
  assert.equal(open?.entries[0].lastTimeHint, "185 lb × 5");
  const history = listHistory(reopened);
  assert.equal(history[0].workoutId, "w-new");
  assert.equal(history[1].label, "Leg Day");
  assert.equal(history[1].setCount, 1);
  reopened.close();
});

test("backup replaces data and rolls back a broken apply", () => {
  const database = db();
  startWorkout(database, { actionId: "w1", label: "Push", now: NOW, localDate: "2026-11-03" });
  const files = memoryFiles();
  const raw = JSON.stringify(exportBackup(database, NOW));
  finishWorkout(database, "w1", NOW);
  startWorkout(database, { actionId: "w2", label: "Later", now: NOW, localDate: "2026-11-03" });
  const restored = restoreBackup(database, files, raw, NOW);
  assert.equal(restored.ok, true);
  assert.equal(getWorkout(database, "w1")?.label, "Push");
  assert.equal(getWorkout(database, "w2"), null);

  const rejected = restoreBackup(database, files, JSON.stringify({ kind: "other" }), NOW);
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.code, "UNSUPPORTED_FORMAT");
  assert.equal(getWorkout(database, "w1")?.label, "Push");

  const current = exportBackup(database, NOW);
  const broken = structuredClone(current);
  broken.records.workoutSets.push({
    id: "missing-parent",
    workout_exercise_id: "does-not-exist",
    position: 1,
    load_lb: "100",
    reps: 5,
    duration_sec: null,
    assisted: 0,
    note: null,
    logged_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  });
  broken.counts.workoutSets += 1;
  assert.throws(() => applyBackup(database, broken));
  assert.equal(getWorkout(database, "w1")?.label, "Push");
});

test("search finds the catalog and a created exercise", () => {
  const database = db();
  assert.ok(searchExercises(database, "bench").some((exercise) => exercise.name === "Barbell Bench Press"));
  const created = createExercise(database, {
    actionId: "custom-1",
    name: "Hack Squat",
    type: "machine",
    now: NOW,
  });
  assert.equal(created.ok, true);
  assert.equal(createExercise(database, { actionId: "custom-2", name: "hack squat", type: "machine", now: NOW }).ok, false);
});

test("trend request omits notes and reports unavailable when the server is down", async () => {
  const database = db();
  startWorkout(database, { actionId: "w1", label: "Bench", now: NOW, localDate: "2026-10-01" });
  addExerciseToWorkout(database, { actionId: "e1", workoutId: "w1", exerciseId: "seed-bench", now: NOW });
  confirmSet(database, {
    actionId: "s1",
    workoutId: "w1",
    exerciseId: "seed-bench",
    totalLb: "100",
    reps: 5,
    assisted: false,
    note: "easy",
    now: NOW,
  });
  const body = buildTrendRequest(database, "2026-10-01", "2026-10-14");
  assert.equal(body.workouts[0].exercises[0].sets[0].loadLb, "100");
  assert.equal(JSON.stringify(body).includes("easy"), false);
  const unavailable = await requestTrends({
    baseUrl: "http://127.0.0.1:9",
    body,
    timeoutMs: 200,
  });
  assert.equal(unavailable.ok, false);
  if (!unavailable.ok) assert.equal(unavailable.code, "UNAVAILABLE");
  assert.equal(getWorkout(database, "w1")?.entries[0].sets.length, 1);
});

test("finds stored aliases in a muscle group and keeps custom exercises discoverable", () => {
  const database = db();
  database.run(`INSERT INTO exercise_name
    (id, exercise_id, display_name, normalized_name, is_canonical, created_at, updated_at)
    VALUES ('bench-alias', 'seed-bench', 'Flat press', 'flat press', 0, ?, ?)`, [NOW, NOW]);
  assert.equal(createExercise(database, { actionId: "custom", name: "Custom press", type: "machine", now: NOW }).ok, true);
  const exact = browseExercises(database, "flat press", "Chest");
  assert.deepEqual(exact.map(({ exerciseId, matchedAlias }) => [exerciseId, matchedAlias]), [["seed-bench", "Flat press"]]);
  assert.deepEqual(browseExercises(database, "flat press", "Back"), []);
  assert.deepEqual(browseExercises(database, "custom", "Unclassified").map((item) => item.exerciseId), ["custom"]);
  assert.equal(searchExercises(database, "flat press").length, 0);
  database.run("UPDATE exercise_name SET deleted_at = ? WHERE id = 'bench-alias'", [NOW]);
  assert.deepEqual(browseExercises(database, "flat press", "All"), []);
});

test("shows a comparable performed set and leaves repeat drafts outside the log", () => {
  const database = db();
  startWorkout(database, { actionId: "previous", label: "Push", now: EARLIER, localDate: "2026-11-01" });
  addExerciseToWorkout(database, { actionId: "old-entry", workoutId: "previous", exerciseId: "seed-bench", now: EARLIER });
  confirmSet(database, { actionId: "prior-set", workoutId: "previous", exerciseId: "seed-bench", totalLb: "135", reps: 6, assisted: true, note: null, now: EARLIER });
  finishWorkout(database, "previous", EARLIER);
  startWorkout(database, { actionId: "current", label: "Mixed", now: NOW, localDate: "2026-11-03" });
  for (const exerciseId of ["seed-bench", "seed-pushup", "seed-squat"]) {
    addExerciseToWorkout(database, { actionId: exerciseId, workoutId: "current", exerciseId, now: NOW });
  }
  const [bench, pushup] = getWorkout(database, "current")!.entries;
  assert.equal(pushup.lastComparableSet, null);
  assert.equal(bench.lastComparableSet?.set.line, "135 lb × 6");
  assert.equal(bench.lastComparableSet?.set.assisted, true);
  assert.equal(bench.sets.length, 0);
  const draft = { actionId: "new-set", workoutId: "current", exerciseId: "seed-bench", totalLb: "140", reps: 5, assisted: false, note: null, now: NOW };
  assert.equal(confirmSet(database, draft).ok, true);
  assert.equal(confirmSet(database, draft).ok, true);
  assert.equal(confirmSet(database, { ...draft, exerciseId: "seed-squat" }).ok, false);
  const saved = getWorkout(database, "current")!.entries[0];
  assert.equal(saved.sets.length, 1);
  assert.equal(saved.lastComparableSet?.set.setId, "new-set");
  assert.equal(saved.lastComparableSet?.currentWorkout, true);
  assert.equal(deleteSet(database, draft.actionId, NOW).ok, true);
  assert.equal(getWorkout(database, "current")!.entries[0].lastComparableSet?.set.setId, "prior-set");
  assert.equal(confirmSet(database, draft).ok, false);
});
