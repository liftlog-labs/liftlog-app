import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { sha256Hex } from "../shared/digest";
import { migrate } from "../storage/schema";
import { openNodeDatabase, type NodeDatabase } from "../storage/nodeDriver";
import { exportBackup, memoryFiles, restoreBackup } from "./backup";
import { hasChatConsent, requestChat } from "./chat";
import { personalContextFromDatabase } from "./personalContext";
import { requestTrends } from "./trends";
import { EMPTY_PROFILE, readTrainingProfile, saveTrainingProfile } from "./trainingProfile";
import { addExerciseToWorkout, confirmSet, finishWorkout, listHistory, startWorkout } from "./workout";
import {
  accessAfterAuthResult,
  accountKeyForEmail,
  ANONYMOUS_DATABASE,
  commitIfCurrent,
  databaseFile,
  draftForWorkspace,
  gateProtectedCall,
  holdAccess,
  logoutNotice,
  memorySecretStore,
  performLogout,
  readStoredAccess,
  serializeAccess,
  SESSION_KEY,
  signedInAccess,
  submitCredentials,
  workspaceIdFor,
} from "./accountSession";

const NOW = "2026-11-05T15:00:00.000Z";
const LATER = "2026-12-05T15:00:00.000Z";
const TOKEN = "session-token-not-for-sqlite";

function files() {
  const dir = mkdtempSync(path.join(tmpdir(), "liftlog-accounts-"));
  const open = new Map<string, NodeDatabase>();
  return {
    open(name: string) {
      const current = open.get(name);
      if (current) return current;
      const db = openNodeDatabase(path.join(dir, name));
      migrate(db, NOW);
      open.set(name, db);
      return db;
    },
    close(name: string) {
      open.get(name)?.close();
      open.delete(name);
    },
    dispose() {
      for (const db of open.values()) db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function session(email: string, token = TOKEN, expiresAt = LATER) {
  return signedInAccess({
    email,
    displayName: email,
    token,
    serverOrigin: "http://127.0.0.1",
    expiresAt,
    accountId: `acct-${accountKeyForEmail(email).slice(0, 12)}`,
  });
}

function logWorkout(db: NodeDatabase, id: string, label: string) {
  const started = startWorkout(db, { actionId: id, label, now: NOW, localDate: "2026-11-05" });
  assert.equal(started.ok, true);
  if (!started.ok) return "";
  const entry = addExerciseToWorkout(db, { actionId: `${id}-entry`, workoutId: started.value.workoutId, exerciseId: "seed-bench", now: NOW });
  assert.equal(entry.ok, true);
  const saved = confirmSet(db, {
    actionId: `${id}-set`,
    workoutId: started.value.workoutId,
    exerciseId: "seed-bench",
    totalLb: "100",
    reps: 5,
    assisted: false,
    note: null,
    now: NOW,
  });
  assert.equal(saved.ok, true);
  finishWorkout(db, started.value.workoutId, NOW);
  return saved.ok ? saved.value.setId : "";
}

function labels(db: NodeDatabase) {
  return listHistory(db).map((item) => item.label);
}

test("sha256 matches the empty-string and abc vectors", () => {
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("anonymous records stay in liftlog.db when an account is opened", () => {
  const store = files();
  try {
    const anonymous = store.open(ANONYMOUS_DATABASE);
    logWorkout(anonymous, "local-1", "Local Day");
    store.close(ANONYMOUS_DATABASE);
    const account = session("ada@example.com");
    const opened = store.open(databaseFile(account));
    assert.deepEqual(labels(opened), []);
    assert.equal(databaseFile(account).includes("ada@"), false);
    store.close(databaseFile(account));
    assert.deepEqual(labels(store.open(ANONYMOUS_DATABASE)), ["Local Day"]);
  } finally {
    store.dispose();
  }
});

test("account workspaces, drafts, and context stay separate and restore on return", () => {
  const store = files();
  try {
    const ada = session("Ada@Example.com");
    const bee = session("bee@example.com", "bee-token");
    const adaDb = store.open(databaseFile(ada));
    const adaSet = logWorkout(adaDb, "ada-1", "Ada Day");
    saveTrainingProfile(adaDb, { ...EMPTY_PROFILE, goal: "hypertrophy", experience: null, trainingDays: null, sessionMinutes: null, equipment: null, preferences: null }, NOW);
    adaDb.run("INSERT INTO preference (key, value) VALUES ('chat_text_consent', 'granted')");
    store.close(databaseFile(ada));

    const beeDb = store.open(databaseFile(bee));
    logWorkout(beeDb, "bee-1", "Bee Day");
    const beeContext = personalContextFromDatabase(beeDb, NOW, "UTC");
    assert.equal(beeContext.includedSetIds.includes(adaSet), false);
    assert.equal(beeContext.profile.goal, null);
    assert.equal(hasChatConsent(beeDb), false);
    assert.deepEqual(labels(beeDb), ["Bee Day"]);
    assert.equal(draftForWorkspace(workspaceIdFor(ada), workspaceIdFor(bee), "Ada's note"), "");
    store.close(databaseFile(bee));

    const returned = store.open(databaseFile(ada));
    assert.deepEqual(labels(returned), ["Ada Day"]);
    assert.equal(readTrainingProfile(returned).goal, "hypertrophy");
    assert.equal(hasChatConsent(returned), true);
    assert.equal(draftForWorkspace(workspaceIdFor(ada), workspaceIdFor(ada), "Ada's note"), "Ada's note");
    assert.equal(accountKeyForEmail("Ada@Example.com"), accountKeyForEmail("ada@example.com"));
  } finally {
    store.dispose();
  }
});

test("a late response from the previous account does not write into the next one", () => {
  const store = files();
  try {
    const ada = session("ada@example.com");
    const bee = session("bee@example.com", "bee-token");
    const beeDb = store.open(databaseFile(bee));
    let wrote = false;
    const committed = commitIfCurrent({ generation: 1, workspaceId: workspaceIdFor(ada) }, { generation: 2, workspaceId: workspaceIdFor(bee) }, () => {
      wrote = true;
      logWorkout(beeDb, "late-1", "Late Day");
      return "wrote";
    });
    assert.equal(committed, null);
    assert.equal(wrote, false);
    assert.deepEqual(labels(beeDb), []);
  } finally {
    store.dispose();
  }
});

test("offline logging, expiry, rejected login, and offline logout keep the current records", async () => {
  const store = files();
  try {
    const ada = session("ada@example.com");
    const adaDb = store.open(databaseFile(ada));
    logWorkout(adaDb, "ada-1", "Ada Day");
    const expired = readStoredAccess(serializeAccess(ada), "2027-01-01T00:00:00.000Z");
    assert.equal(expired.access.mode, "signed-out-hold");
    assert.equal(databaseFile(expired.access), databaseFile(ada));
    assert.equal(expired.rewrite?.includes(TOKEN), false);
    const gate = gateProtectedCall({
      access: expired.access,
      sent: { generation: 2, workspaceId: workspaceIdFor(expired.access) },
      active: { generation: 2, workspaceId: workspaceIdFor(expired.access) },
      consent: true,
      now: "2027-01-01T00:00:00.000Z",
    });
    assert.deepEqual(gate, { action: "stop", code: "SIGN_IN" });
    const started = startWorkout(adaDb, { actionId: "offline", label: "Offline Day", now: NOW, localDate: "2026-11-05" });
    assert.equal(started.ok, true);
    assert.equal(labels(adaDb).includes("Offline Day"), true);

    const rejected = await submitCredentials({
      baseUrl: "http://127.0.0.1:9",
      mode: "login",
      email: "ada@example.com",
      password: "not-the-password",
      fetchImpl: async () => new Response(JSON.stringify({ code: "INVALID_CREDENTIALS" }), { status: 401 }),
    });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.code, "AUTH_REJECTED");
    assert.equal(JSON.stringify(rejected).includes("not-the-password"), false);
    assert.equal(accessAfterAuthResult(expired.access, rejected), expired.access);

    const offline = await submitCredentials({
      baseUrl: "http://127.0.0.1:9",
      mode: "login",
      email: "ada@example.com",
      password: "Liftlog-Test-Pass-1",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.deepEqual(offline, { ok: false, code: "UNAVAILABLE" });
    assert.equal(accessAfterAuthResult({ mode: "anonymous" }, offline).mode, "anonymous");

    const secrets = memorySecretStore();
    await secrets.set(SESSION_KEY, serializeAccess(ada) ?? "");
    const signedOut = await performLogout({
      access: ada,
      store: secrets,
      baseUrl: "http://127.0.0.1:9",
      fetchImpl: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(await secrets.get(SESSION_KEY), null);
    assert.equal(signedOut.notice, logoutNotice("unreachable"));
    assert.equal(signedOut.notice.includes("and on the server"), false);
    assert.equal(signedOut.notice.includes(TOKEN), false);
    store.close(databaseFile(ada));
    assert.deepEqual(labels(store.open(ANONYMOUS_DATABASE)), []);
    assert.equal(labels(store.open(databaseFile(ada))).includes("Ada Day"), true);
    assert.equal(holdAccess(ada).mode, "signed-out-hold");
  } finally {
    store.dispose();
  }
});

test("backup and restore stay inside the active workspace and omit credentials", () => {
  const store = files();
  try {
    const ada = session("ada@example.com");
    const bee = session("bee@example.com", "bee-token");
    const adaDb = store.open(databaseFile(ada));
    const beeDb = store.open(databaseFile(bee));
    logWorkout(adaDb, "ada-1", "Ada Day");
    logWorkout(beeDb, "bee-1", "Bee Day");
    adaDb.run("INSERT INTO preference (key, value) VALUES ('auth_token', ?)", [TOKEN]);
    const exported = exportBackup(adaDb, NOW, workspaceIdFor(ada));
    const encoded = JSON.stringify(exported);
    assert.equal(encoded.includes(TOKEN), false);
    assert.equal(encoded.includes("auth_token"), false);
    assert.equal(exported.workspace, workspaceIdFor(ada));

    const refused = restoreBackup(beeDb, memoryFiles(), encoded, NOW, workspaceIdFor(bee));
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.code, "WORKSPACE_MISMATCH");
    assert.deepEqual(labels(beeDb), ["Bee Day"]);
    assert.deepEqual(labels(adaDb), ["Ada Day"]);

    const crafted = exportBackup(adaDb, NOW, workspaceIdFor(ada));
    crafted.preferences.push({ key: "password", value: "hunter2" });
    crafted.counts.preferences += 1;
    const poisoned = restoreBackup(adaDb, memoryFiles(), JSON.stringify(crafted), NOW, workspaceIdFor(ada));
    assert.equal(poisoned.ok, false);
    if (!poisoned.ok) assert.equal(poisoned.code, "INVALID_BACKUP");
    assert.deepEqual(labels(adaDb), ["Ada Day"]);

    const legacy = exportBackup(adaDb, NOW);
    assert.equal(legacy.workspace, undefined);
    const imported = restoreBackup(beeDb, memoryFiles(), JSON.stringify(legacy), NOW, workspaceIdFor(bee));
    assert.equal(imported.ok, true);
    assert.deepEqual(labels(adaDb), ["Ada Day"]);
    assert.equal(labels(beeDb).includes("Ada Day"), true);
  } finally {
    store.dispose();
  }
});

test("protected calls attach a token only for the current consented account", async () => {
  const ada = session("ada@example.com");
  const stamp = { generation: 1, workspaceId: workspaceIdFor(ada) };
  const anonymous = gateProtectedCall({
    access: { mode: "anonymous" },
    sent: { generation: 1, workspaceId: "anonymous" },
    active: { generation: 1, workspaceId: "anonymous" },
    consent: true,
    now: NOW,
  });
  assert.deepEqual(anonymous, { action: "send", authorization: null });
  const denied = gateProtectedCall({ access: ada, sent: stamp, active: stamp, consent: false, now: NOW });
  assert.deepEqual(denied, { action: "stop", code: "CONSENT_REQUIRED" });
  const allowed = gateProtectedCall({ access: ada, sent: stamp, active: stamp, consent: true, now: NOW });
  assert.deepEqual(allowed, { action: "send", authorization: TOKEN });

  const stored = readStoredAccess(JSON.stringify({ ...ada, password: "hunter2" }), NOW);
  assert.equal(stored.discard, true);
  assert.equal(stored.access.mode, "anonymous");

  let header: string | null = "missing";
  const chat = await requestChat({
    baseUrl: "http://127.0.0.1",
    boundOrigin: "http://127.0.0.1",
    authorization: allowed.action === "send" ? allowed.authorization : null,
    body: { note: "doing legs today", consent: true, contextRevision: "none", workout: null, exercises: [] },
    fetchImpl: async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      header = headers.Authorization ?? null;
      return new Response(JSON.stringify({ code: "UNAUTHENTICATED" }), { status: 401 });
    },
  });
  assert.equal(header, `Bearer ${TOKEN}`);
  assert.equal(chat.ok, false);
  if (!chat.ok) assert.equal(chat.code, "SIGN_IN");
  assert.equal(JSON.stringify(chat).includes(TOKEN), false);

  const trends = await requestTrends({
    baseUrl: "http://127.0.0.1",
    boundOrigin: "http://127.0.0.1",
    authorization: null,
    body: { range: { start: "2026-10-01", end: "2026-10-14" }, workouts: [] },
    fetchImpl: async (_url, init) => {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, undefined);
      return new Response("{}", { status: 401 });
    },
  });
  assert.equal(trends.ok, false);
  if (!trends.ok) assert.equal(trends.code, "SIGN_IN");
});

test("memory session storage is not shared and does not claim to persist", async () => {
  const first = memorySecretStore();
  const second = memorySecretStore();
  await first.set(SESSION_KEY, "one");
  assert.equal(await second.get(SESSION_KEY), null);
  assert.equal(first.persistent, false);
  await first.remove(SESSION_KEY);
  assert.equal(await first.get(SESSION_KEY), null);
});

test('protected calls distinguish a different selected server without sending',()=>{
 const stamp={generation:1,workspaceId:'account'};
 const access=({...session('ada@example.test'),serverOrigin:'https://account.example'});
 assert.deepEqual(gateProtectedCall({access,sent:stamp,active:stamp,consent:true,now:NOW,targetServer:'https://different.example'}),{action:'stop',code:'WORKSPACE_MISMATCH'});
 assert.deepEqual(gateProtectedCall({access,sent:stamp,active:stamp,consent:true,now:NOW,targetServer:'invalid'}),{action:'stop',code:'INVALID_INPUT'});
});
