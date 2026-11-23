import assert from "node:assert/strict";
import test from "node:test";
import { exportBackup, memoryFiles, restoreBackup } from "./backup";
import { buildPersonalContext, personalContextFromDatabase, type PersonalSnapshot } from "./personalContext";
import { EMPTY_PROFILE, readTrainingProfile, saveTrainingProfile, type TrainingProfile } from "./trainingProfile";
import { addExerciseToWorkout, confirmSet, deleteSet, finishWorkout, startWorkout, updateSet } from "./workout";
import { migrate } from "../storage/schema";
import { openNodeDatabase } from "../storage/nodeDriver";

const NOW = "2026-11-03T18:00:00.000Z";

function profile(overrides: Partial<TrainingProfile> = {}): TrainingProfile {
  return { ...EMPTY_PROFILE, revision: 1, updatedAt: NOW, ...overrides };
}

function performed(overrides: Partial<PersonalSnapshot["performedSets"][number]> = {}) {
  return {
    id: "set-1",
    exerciseId: "squat",
    exerciseName: "Barbell Back Squat",
    exerciseType: "barbell" as const,
    workoutId: "w1",
    workoutLabel: "Leg Day",
    date: "2026-11-01",
    loadLb: "185",
    reps: 5,
    assisted: false,
    ended: true,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PersonalSnapshot> = {}): PersonalSnapshot {
  return {
    asOf: "2026-11-03T18:00:00.000Z",
    timeZone: "America/Chicago",
    profile: profile({ goal: "hypertrophy", equipment: ["barbell"] }),
    performedSets: [performed()],
    plannedSets: [],
    activeWorkout: null,
    ...overrides,
  };
}

test("distinct profiles produce distinct context", () => {
  const hypertrophy = buildPersonalContext(snapshot());
  const strength = buildPersonalContext(snapshot({ profile: profile({ goal: "strength", experience: "beginner" }) }));
  assert.equal(hypertrophy.profile.goal, "hypertrophy");
  assert.equal(strength.profile.goal, "strength");
  assert.notEqual(hypertrophy.revision, strength.revision);
  assert.equal(strength.profile.experience, "beginner");
  assert.equal(hypertrophy.profile.experience, null);
});

test("sparse history does not call missing days rest", () => {
  const context = buildPersonalContext(snapshot());
  assert.equal(context.recentSessions.length, 1);
  assert.equal(context.gaps.some((gap) => gap.includes("rest day")), false);
  assert.equal(context.gaps.some((gap) => gap.includes("sparse")), true);
});

test("future-dated records and the local date boundary stay out of the window", () => {
  const context = buildPersonalContext(
    snapshot({
      asOf: "2026-11-04T04:30:00.000Z",
      timeZone: "America/Chicago",
      performedSets: [
        performed({ id: "today", date: "2026-11-03" }),
        performed({ id: "tomorrow", date: "2026-11-04", loadLb: "500", reps: 10 }),
      ],
    }),
  );
  assert.equal(context.localDate, "2026-11-03");
  assert.equal(context.includedSetIds.includes("today"), true);
  assert.equal(context.includedSetIds.includes("tomorrow"), false);
  assert.equal(context.performedVolumeLb, "925");
  assert.equal(context.gaps.some((gap) => gap.includes("tomorrow")), true);
});

test("ambiguous loads, assisted sets, and planned targets stay out of performed totals", () => {
  const context = buildPersonalContext(
    snapshot({
      performedSets: [
        performed({ id: "clear", loadLb: "100", reps: 5 }),
        performed({ id: "assisted", loadLb: "300", reps: 5, assisted: true }),
        performed({ id: "ambiguous", loadLb: "45 x 80", reps: 5 }),
      ],
      plannedSets: [{ id: "planned", exerciseId: "squat", loadLb: "1000", reps: 10 }],
    }),
  );
  assert.equal(context.performedVolumeLb, "500");
  assert.equal(context.baselines.some((baseline) => baseline.setId === "assisted"), false);
  assert.equal(context.baselines[0]?.exerciseType, "barbell");
  assert.equal(context.includedSetIds.includes("planned"), false);
  assert.equal(context.gaps.some((gap) => gap.includes("ambiguous")), true);
  assert.equal(context.activePlan, null);
});

test("changed equipment does not rewrite older barbell history", () => {
  const before = buildPersonalContext(snapshot({ profile: profile({ equipment: ["barbell"] }) }));
  const after = buildPersonalContext(snapshot({ profile: profile({ equipment: ["dumbbell"], revision: 2 }) }));
  assert.deepEqual(before.baselines[0]?.exerciseType, "barbell");
  assert.deepEqual(after.baselines[0]?.exerciseType, "barbell");
  assert.deepEqual(after.profile.equipment, ["dumbbell"]);
});

test("database history omits deleted sets and uses the corrected load", () => {
  const db = openNodeDatabase();
  migrate(db, NOW);
  saveTrainingProfile(db, { ...EMPTY_PROFILE, goal: "hypertrophy", experience: null, trainingDays: 4, sessionMinutes: 60, equipment: ["barbell"], preferences: null }, NOW);
  startWorkout(db, { actionId: "w1", label: "Leg Day", now: NOW, localDate: "2026-11-01" });
  addExerciseToWorkout(db, { actionId: "entry", workoutId: "w1", exerciseId: "seed-squat", now: NOW });
  confirmSet(db, { actionId: "kept", workoutId: "w1", exerciseId: "seed-squat", totalLb: "135", reps: 5, assisted: false, note: null, now: NOW });
  confirmSet(db, { actionId: "gone", workoutId: "w1", exerciseId: "seed-squat", totalLb: "95", reps: 5, assisted: false, note: null, now: NOW });
  updateSet(db, { setId: "kept", exerciseId: "seed-squat", totalLb: "155", reps: 5, assisted: false, note: null, now: NOW });
  deleteSet(db, "gone", NOW);
  finishWorkout(db, "w1", NOW);
  const context = personalContextFromDatabase(db, "2026-11-03T18:00:00.000Z", "America/Chicago");
  assert.equal(context.profile.goal, "hypertrophy");
  assert.equal(context.profile.trainingDays, 4);
  assert.equal(context.performedVolumeLb, "775");
  assert.equal(context.includedSetIds.includes("gone"), false);
  assert.equal(context.baselines[0]?.loadLb, "155");
  assert.equal(context.baselines[0]?.setId, "kept");
  db.close();
});

test("profile edits stay unknown until set and round-trip through backup", () => {
  const db = openNodeDatabase();
  migrate(db, NOW);
  assert.equal(readTrainingProfile(db).goal, null);
  const saved = saveTrainingProfile(
    db,
    { ...EMPTY_PROFILE, goal: "hypertrophy", experience: "intermediate", trainingDays: null, sessionMinutes: 45, equipment: null, preferences: [{ exerciseId: "seed-squat", stance: "prefer" }] },
    NOW,
  );
  assert.equal(saved.ok, true);
  const files = memoryFiles();
  const raw = JSON.stringify(exportBackup(db, NOW));
  saveTrainingProfile(db, { ...EMPTY_PROFILE, goal: "strength", experience: null, trainingDays: null, sessionMinutes: null, equipment: null, preferences: null }, NOW);
  const restored = restoreBackup(db, files, raw, NOW);
  assert.equal(restored.ok, true);
  const profile = readTrainingProfile(db);
  assert.equal(profile.goal, "hypertrophy");
  assert.equal(profile.sessionMinutes, 45);
  assert.equal(profile.trainingDays, null);
  assert.equal(profile.preferences?.[0]?.stance, "prefer");

  const oldBackup = exportBackup(db, NOW);
  delete (oldBackup.records as { trainingProfiles?: unknown }).trainingProfiles;
  delete (oldBackup.counts as { trainingProfiles?: unknown }).trainingProfiles;
  const oldRestore = restoreBackup(db, files, JSON.stringify(oldBackup), NOW);
  assert.equal(oldRestore.ok, true);
  assert.equal(readTrainingProfile(db).goal, null);
  db.close();
});

test("corrections, deletions, preferences and the active workout change the revision", () => {
  const base = snapshot({
    activeWorkout: { id: "open", label: "Leg Day", date: "2026-11-03" },
    profile: profile({ preferences: [{ exerciseId: "squat", stance: "prefer" }] }),
  });
  const corrected = snapshot({
    activeWorkout: base.activeWorkout,
    profile: base.profile,
    performedSets: [performed({ loadLb: "205" })],
  });
  const deleted = snapshot({
    activeWorkout: base.activeWorkout,
    profile: base.profile,
    performedSets: [performed({ deleted: true })],
  });
  const preference = snapshot({
    activeWorkout: base.activeWorkout,
    profile: profile({ preferences: [{ exerciseId: "squat", stance: "avoid" }] }),
  });
  const otherWorkout = snapshot({
    profile: base.profile,
    activeWorkout: { id: "other", label: "Push", date: "2026-11-03" },
  });
  const original = buildPersonalContext(base).revision;
  assert.notEqual(buildPersonalContext(corrected).revision, original);
  assert.notEqual(buildPersonalContext(deleted).revision, original);
  assert.notEqual(buildPersonalContext(preference).revision, original);
  assert.notEqual(buildPersonalContext(otherWorkout).revision, original);
});

test("same-day sets without timestamps are not ordered by id", () => {
  const context = buildPersonalContext(
    snapshot({
      performedSets: [
        performed({ id: "b", loadLb: "100", reps: 5, loggedAt: null }),
        performed({ id: "a", loadLb: "200", reps: 5, loggedAt: null }),
      ],
    }),
  );
  assert.deepEqual(context.recentSessions[0]?.setIds, ["b", "a"]);
  assert.equal(context.recentSessions[0]?.setOrder, "unordered");
  assert.equal(context.baselines.length, 0);
  assert.equal(context.gaps.some((gap) => gap.includes("timestamps are missing")), true);
  assert.equal(context.performedVolumeLb, "1500");
});

test("a logged time chooses the later set even when its id sorts first", () => {
  const context = buildPersonalContext(
    snapshot({
      performedSets: [
        performed({ id: "a", loadLb: "100", reps: 5, loggedAt: "2026-11-01T15:00:00.000Z" }),
        performed({ id: "z", loadLb: "140", reps: 5, loggedAt: "2026-11-01T18:00:00.000Z" }),
      ],
    }),
  );
  assert.equal(context.baselines[0]?.setId, "z");
  assert.equal(context.baselines[0]?.loadLb, "140");
  assert.equal(context.recentSessions[0]?.setOrder, "logged_at");
});

test("session and gap limits are explicit and totals match the included sets", () => {
  const performedSets = Array.from({ length: 9 }, (_, index) =>
    performed({
      id: `set-${index}`,
      workoutId: `w-${index}`,
      date: `2026-10-${String(index + 10).padStart(2, "0")}`,
      loadLb: "10",
      reps: 1,
    }),
  );
  const longId = "x".repeat(200);
  performedSets.push(performed({ id: longId, workoutId: "w-ambiguous", date: "2026-11-02", loadLb: "45 x 80", reps: 5 }));
  const context = buildPersonalContext(snapshot({ performedSets }));
  assert.equal(context.recentSessions.length, 8);
  assert.equal(context.truncation.truncated, true);
  assert.equal(context.truncation.reasons.some((reason) => reason.includes("Recent sessions")), true);
  assert.equal(context.truncation.reasons.some((reason) => reason.includes("Gap text")), true);
  assert.equal(context.gaps.every((gap) => gap.length <= 160), true);
  const includedVolume = context.includedSetIds.filter((id) => id.startsWith("set-")).length * 10;
  assert.equal(context.performedVolumeLb, String(includedVolume));
  assert.deepEqual(context.includedSetIds, context.recentSessions.flatMap((session) => session.setIds));
});

test("native strip-types bridge matches the local pure engine exactly", async () => {
  const { execFileSync } = await import("node:child_process");
  const input = snapshot({ performedSets: [performed({ loggedAt: NOW }), performed({ id: "set-2", workoutId: "w2", date: "2026-11-02", exerciseName: "Custom exercise", loadLb: "20", reps: 8 })] });
  const bridged = JSON.parse(execFileSync(process.execPath, ["scripts/personal-context.mjs"], { input: JSON.stringify(input), encoding: "utf8", timeout: 5000, env: { TZ: "UTC", NODE_ENV: "test" } }));
  assert.deepEqual(bridged, buildPersonalContext(input));
});

test("malformed oversized persisted numbers cannot inflate totals", () => {
  const context = buildPersonalContext(snapshot({ performedSets: [performed({ loadLb: "9999999999999999999999999", reps: 1000000000 })] }));
  assert.equal(context.performedVolumeLb, "0");
  assert.equal(context.baselines.length, 0);
  assert.match(context.revision, /^[a-f0-9]{64}$/);
});

test("unordered sets use stable membership without inventing chronology", () => {
  const sets = Array.from({ length: 14 }, (_, i) => performed({ id: `s${String(i).padStart(2, "0")}` }));
  const first = buildPersonalContext(snapshot({ performedSets: sets }));
  const reversed = buildPersonalContext(snapshot({ performedSets: [...sets].reverse() }));
  assert.deepEqual(new Set(first.includedSetIds), new Set(reversed.includedSetIds));
  assert.equal(first.recentSessions[0].setOrder, "unordered");
  assert.equal(first.baselines.length, 0);
});
