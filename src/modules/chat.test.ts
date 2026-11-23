import assert from "node:assert/strict";
import test from "node:test";
import { exportBackup } from "./backup";
import { migrate } from "../storage/schema";
import { openNodeDatabase } from "../storage/nodeDriver";
import { applyChatResponse, buildChatRequest, contextRevision, grantChatConsent, requestChat, undoLoggedSet } from "./chat";
import { finishWorkout, getOpenWorkout, getWorkout, startWorkout } from "./workout";

const NOW = "2026-11-03T18:00:00.000Z";

function db() {
  const database = openNodeDatabase();
  migrate(database, NOW);
  return database;
}

test("starting leg day from chat creates one workout and a repeat does not create another", () => {
  const database = db();
  const sent = contextRevision(database);
  const response = {
    version: 1 as const,
    status: "proposal" as const,
    contextRevision: sent,
    proposal: { kind: "start_workout" as const, label: "Leg Day" },
  };
  const first = applyChatResponse(database, { actionId: "act-1", sentRevision: sent, response, now: NOW, localDate: "2026-11-03" });
  const second = applyChatResponse(database, { actionId: "act-1", sentRevision: sent, response, now: NOW, localDate: "2026-11-03" });
  assert.equal(first.ok && first.value.kind, "started");
  assert.equal(second.ok && second.value.kind, "started");
  assert.equal(getOpenWorkout(database)?.label, "Leg Day");
  const rows = database.all("SELECT id FROM workout WHERE deleted_at IS NULL");
  assert.equal(rows.length, 1);
});

test("a leg press proposal saves one set and undo removes it", () => {
  const database = db();
  applyChatResponse(database, {
    actionId: "workout-1",
    sentRevision: "none",
    response: { version: 1, status: "proposal", contextRevision: "none", proposal: { kind: "start_workout", label: "Leg Day" } },
    now: NOW,
    localDate: "2026-11-03",
  });
  const open = getOpenWorkout(database);
  const sent = contextRevision(database);
  const response = {
    version: 1 as const,
    status: "proposal" as const,
    contextRevision: sent,
    proposal: {
      kind: "log_set" as const,
      workoutId: open!.workoutId,
      exerciseId: "seed-leg-press",
      exerciseName: "Leg Press",
      loadLb: "100",
      reps: 10,
      assisted: false,
    },
  };
  const saved = applyChatResponse(database, { actionId: "set-1", sentRevision: sent, response, now: NOW, localDate: "2026-11-03" });
  applyChatResponse(database, { actionId: "set-1", sentRevision: sent, response, now: NOW, localDate: "2026-11-03" });
  assert.equal(saved.ok && saved.value.line, "Leg Press 100 lb × 10");
  assert.equal(getWorkout(database, open!.workoutId)?.entries[0].sets.length, 1);
  assert.equal(undoLoggedSet(database, "set-1", NOW).ok, true);
  assert.equal(getWorkout(database, open!.workoutId)?.entries[0].sets.length, 0);
});

test("a delayed reply does not write into a finished workout", () => {
  const database = db();
  applyChatResponse(database, {
    actionId: "workout-1",
    sentRevision: "none",
    response: { version: 1, status: "proposal", contextRevision: "none", proposal: { kind: "start_workout", label: "Leg Day" } },
    now: NOW,
    localDate: "2026-11-03",
  });
  const sent = contextRevision(database);
  const workoutId = getOpenWorkout(database)!.workoutId;
  finishWorkout(database, workoutId, NOW);
  const late = applyChatResponse(database, {
    actionId: "set-late",
    sentRevision: sent,
    response: {
      version: 1,
      status: "proposal",
      contextRevision: sent,
      proposal: {
        kind: "log_set",
        workoutId,
        exerciseId: "seed-leg-press",
        exerciseName: "Leg Press",
        loadLb: "100",
        reps: 10,
        assisted: false,
      },
    },
    now: NOW,
    localDate: "2026-11-03",
  });
  assert.equal(late.ok, false);
  if (!late.ok) assert.equal(late.code, "STALE");
  assert.equal(getWorkout(database, workoutId)?.entries.length, 0);
});

test("an unknown exercise id is not saved", () => {
  const database = db();
  applyChatResponse(database, {
    actionId: "workout-1",
    sentRevision: "none",
    response: { version: 1, status: "proposal", contextRevision: "none", proposal: { kind: "start_workout", label: "Leg Day" } },
    now: NOW,
    localDate: "2026-11-03",
  });
  const sent = contextRevision(database);
  const workoutId = getOpenWorkout(database)!.workoutId;
  const rejected = applyChatResponse(database, {
    actionId: "set-x",
    sentRevision: sent,
    response: {
      version: 1,
      status: "proposal",
      contextRevision: sent,
      proposal: {
        kind: "log_set",
        workoutId,
        exerciseId: "not-a-real-exercise",
        exerciseName: "Invented Press",
        loadLb: "100",
        reps: 10,
        assisted: false,
      },
    },
    now: NOW,
    localDate: "2026-11-03",
  });
  assert.equal(rejected.ok, false);
  assert.equal(getWorkout(database, workoutId)?.entries.length, 0);
});

test("chat request sends no health data and keeps the workout when django is down", async () => {
  const database = db();
  const body = buildChatRequest(database, "Leg press 100 x 10");
  assert.equal(JSON.stringify(body).toLowerCase().includes("health"), false);
  assert.equal(body.exercises.some((exercise) => exercise.name === "Leg Press"), true);
  const unavailable = await requestChat({ baseUrl: "http://127.0.0.1:9", body, timeoutMs: 200 });
  assert.equal(unavailable.ok, false);
  assert.equal(getOpenWorkout(database), null);
});

test("a model-shaped proposal with a bad exercise id or a stale workout is not saved", () => {
  const database = db();
  startWorkout(database, { actionId: "w1", label: "Leg Day", now: NOW, localDate: "2026-11-03" });
  const sent = contextRevision(database);
  const unknown = applyChatResponse(database, {
    actionId: "model-set",
    sentRevision: sent,
    response: {
      version: 1,
      status: "proposal",
      contextRevision: sent,
      proposal: {
        kind: "log_set",
        workoutId: "w1",
        exerciseId: "not-in-catalog",
        exerciseName: "Invented Press",
        loadLb: "100",
        reps: 10,
        assisted: false,
      },
    },
    now: NOW,
    localDate: "2026-11-03",
  });
  assert.equal(unknown.ok, false);
  finishWorkout(database, "w1", NOW);
  const stale = applyChatResponse(database, {
    actionId: "model-set-2",
    sentRevision: sent,
    response: {
      version: 1,
      status: "proposal",
      contextRevision: sent,
      proposal: {
        kind: "log_set",
        workoutId: "w1",
        exerciseId: "seed-leg-press",
        exerciseName: "Leg Press",
        loadLb: "100",
        reps: 10,
        assisted: false,
      },
    },
    now: NOW,
    localDate: "2026-11-03",
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.code, "STALE");
  database.close();
});

test('complete model validation rejects malformed responses without any local mutation',()=>{
 const db=openNodeDatabase();migrate(db,NOW);
 const before=exportBackup(db,NOW);
 const malformed:unknown[]=[null,{}, {version:1,status:'proposal',contextRevision:'none',proposal:null}, {version:1,status:'proposal',contextRevision:'none',proposal:{actions:[{kind:'start_workout',label:'Bad'}]}},{version:1,status:'proposal',contextRevision:'none',proposal:{kind:'execute_sql',sql:'synthetic'}},{version:1,status:'proposal',contextRevision:'none',proposal:{kind:'start_workout',label:'Bad',ownerId:'other'}},{version:1,status:'clarify',contextRevision:'none',question:null,reason:'workout'}];
 for(const response of malformed){const result=applyChatResponse(db,{actionId:'bad',sentRevision:'none',response,now:NOW,localDate:'2026-11-15'});assert.equal(result.ok,false);assert.deepEqual(exportBackup(db,NOW).records,before.records);}
 db.close();
});

test('chat transport rejects stale revisions, forged ids and numeric/type violations',async()=>{
 const body={note:'Synthetic bench 100 x 5',consent:true as const,contextRevision:'w:open',workout:{id:'w',label:'Synthetic',ended:false as const},exercises:[{id:'e',name:'Synthetic bench',type:'barbell' as const}]};
 const proposal={kind:'log_set',workoutId:'w',exerciseId:'e',exerciseName:'Synthetic bench',loadLb:'100',reps:5,assisted:false};
 for(const patch of [{reps:true},{reps:1001},{loadLb:'0'},{loadLb:'1000000'},{loadLb:'NaN'},{assisted:'false'},{exerciseId:'foreign'},{workoutId:'foreign'},{exerciseName:'spoofed'}]){
  const result=await requestChat({baseUrl:'http://127.0.0.1',body,fetchImpl:async()=>new Response(JSON.stringify({version:1,status:'proposal',contextRevision:body.contextRevision,proposal:{...proposal,...patch}}))});assert.equal(result.ok,false);
 }
 const stale=await requestChat({baseUrl:'http://127.0.0.1',body,fetchImpl:async()=>new Response(JSON.stringify({version:1,status:'proposal',contextRevision:'stale',proposal}))});assert.equal(stale.ok,false);
});

test('a chat set failure rolls back its newly added exercise entry',()=>{
 const database=db();startWorkout(database,{actionId:'atomic',label:'Synthetic',now:NOW,localDate:'2026-11-03'});
 database.exec("CREATE TRIGGER reject_chat_set BEFORE INSERT ON workout_set BEGIN SELECT RAISE(ABORT,'synthetic storage failure'); END");
 const response={version:1,status:'proposal',contextRevision:'atomic:open',proposal:{kind:'log_set',workoutId:'atomic',exerciseId:'seed-leg-press',exerciseName:'Leg Press',loadLb:'100',reps:5,assisted:false}};
 const result=applyChatResponse(database,{actionId:'atomic-action',sentRevision:'atomic:open',response,now:NOW,localDate:'2026-11-03'});
 assert.equal(result.ok,false);assert.equal(database.get<{c:number}>('SELECT COUNT(*) c FROM workout_exercise')!.c,0);database.close();
});

test('logging transport distinguishes network and service failures', async()=>{
 const db=openNodeDatabase();migrate(db);grantChatConsent(db);
 const body=buildChatRequest(db,'Synthetic note');
 const base={baseUrl:'https://synthetic.invalid',body,authorization:'synthetic',boundOrigin:'https://synthetic.invalid'};
 assert.deepEqual(await requestChat({...base,fetchImpl:async()=>{throw new TypeError('offline');}}),{ok:false,code:'NETWORK_ERROR'});
 assert.deepEqual(await requestChat({...base,fetchImpl:async()=>new Response('{}',{status:503})}),{ok:false,code:'SERVICE_ERROR'});
 assert.deepEqual(await requestChat({...base,fetchImpl:async()=>new Response('{')}),{ok:false,code:'SERVICE_ERROR'});
 assert.deepEqual(await requestChat({...base,baseUrl:'https://other.invalid'}),{ok:false,code:'WORKSPACE_MISMATCH'});
 db.close();
});
