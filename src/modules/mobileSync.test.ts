import assert from "node:assert/strict";
import test from "node:test";
import { openNodeDatabase } from "../storage/nodeDriver";
import { migrate, SCHEMA_SQL } from "../storage/schema";
import { repairSyncConflict } from "./syncRepairs";
import { startWorkout, finishWorkout, addExerciseToWorkout, confirmSet, listHistory } from "./workout";
import { saveTrainingProfile } from "./trainingProfile";
import * as store from "./syncStore";
import { createSyncWorker } from "./mobileSync";
import { applyBackup, exportBackup, memoryFiles, restoreBackup } from "./backup";
import { associateWorkspace } from "./syncAssociation";
const NOW = "2026-11-08T12:00:00.000Z";
const URL = "http://127.0.0.1:8000";
function database() { const db = openNodeDatabase(); migrate(db, NOW); return db; }
function workout(db: ReturnType<typeof database>, id = "w") {
  assert.equal(startWorkout(db, { actionId:id, label:"Synthetic", now:NOW, localDate:"2026-11-08" }).ok, true);
  assert.equal(addExerciseToWorkout(db, { actionId:`${id}-entry`, workoutId:id, exerciseId:"seed-bench", now:NOW }).ok, true);
  assert.equal(confirmSet(db, { actionId:`${id}-set`, workoutId:id, exerciseId:"seed-bench", now:NOW, totalLb:"100", reps:5, assisted:false, note:null }).ok, true);
  assert.equal(finishWorkout(db,id,NOW).ok,true);
}

test("local writes and outbox commit atomically, including profile, rollback and dependencies", () => {
  const db = database();
  assert.equal(typeof store.bindSync, "function");
  store.bindSync(db,"account-a",URL);
  workout(db);
  saveTrainingProfile(db,{goal:"hypertrophy",experience:null,trainingDays:4,sessionMinutes:null,equipment:null,preferences:null},NOW);
  const before = db.get<{c:number}>("SELECT COUNT(*) c FROM sync_outbox")!.c;
  assert.throws(()=>db.transaction(()=>{ db.run("UPDATE workout_set SET reps=9 WHERE id='w-set'"); throw Error("interrupt"); }));
  assert.equal(db.get<{c:number}>("SELECT COUNT(*) c FROM sync_outbox")!.c,before);
  assert.equal(db.get<{reps:number}>("SELECT reps FROM workout_set WHERE id='w-set'")!.reps,5);
  const batch=store.prepareBatch(db);
  assert.ok(batch.length>0 && batch.length<=50);
  assert.deepEqual(store.prepareBatch(db),batch);
  assert.ok(batch.every(op=>typeof op.opId==="string" && op.fingerprint.length===64));
  db.close();
});

test("remote page and cursor commit together and never echo into the outbox", () => {
 const db=database(); store.bindSync(db,"a",URL);
 const initial=db.get<{c:number}>("SELECT COUNT(*) c FROM sync_outbox")!.c;
 store.applySyncPage(db,{accountId:"a",cursor:1,complete:true,changes:[{cursor:1,recordType:"workout",clientId:"remote",serverRevision:1,deleted:false,payload:{date:"2026-11-07",label:null,startedAt:null,endedAt:null}}]},NOW);
 assert.equal(store.readSyncState(db).cursor,1); assert.equal(store.readSyncState(db).restored,true);
 assert.equal(db.get<{c:number}>("SELECT COUNT(*) c FROM sync_outbox")!.c,initial);
 assert.equal(listHistory(db)[0]?.workoutId,"remote");
 assert.throws(()=>store.applySyncPage(db,{accountId:"other",cursor:2,complete:true,changes:[]},NOW));
 assert.equal(store.readSyncState(db).cursor,1);
 db.close();
});

test("pull preserves dirty local edits and a tombstone suppresses stale upserts", () => {
 const db=database();store.bindSync(db,"a",URL);workout(db);
 const remote={cursor:1,recordType:"workout_set" as const,clientId:"w-set",serverRevision:2,deleted:false,payload:{workoutExerciseId:"w-entry",position:1,loadLb:"120",reps:3,durationSec:null,assisted:false,note:null,loggedAt:NOW}};
 store.applySyncPage(db,{accountId:"a",cursor:1,complete:true,changes:[remote]},NOW);
 assert.equal(db.get<{load_lb:string}>("SELECT load_lb FROM workout_set WHERE id='w-set'")!.load_lb,"100");
 assert.ok(store.listSyncConflicts(db).some(c=>c.clientId==="w-set"));
 store.applySyncPage(db,{accountId:"a",cursor:2,complete:true,changes:[{...remote,cursor:2,serverRevision:3,deleted:true,payload:null}]},NOW);
 assert.ok(db.get<{deleted_at:string}>("SELECT deleted_at FROM workout_set WHERE id='w-set'")!.deleted_at);
 assert.equal(store.prepareBatch(db).some(op=>op.clientId==="w-set"),false);
 assert.ok(store.listSyncConflicts(db).some(c=>c.clientId==="w-set" && c.localPayload?.loadLb==="100"));
 db.close();
});

function response(body:unknown,status=200) {return new Response(JSON.stringify(body),{status,headers:{"Content-Type":"application/json"}});}
test("worker restores automatically and ignores a late response after account switching",async()=>{
 const db=database();store.bindSync(db,"a",URL);
 let current=true;let release!:(r:Response)=>void;
 const worker=createSyncWorker({db,accountId:"a",baseUrl:URL,token:"synthetic",isCurrent:()=>current,fetchImpl:(async(url)=>{
  if(String(url).endsWith("/account")) return response({accountId:"a",cloudSyncConsent:null});
  return await new Promise<Response>(r=>{release=r;});
 }) as typeof fetch});
 const run=worker.run();while(!release) await new Promise(r=>setTimeout(r,0));
 current=false;release(response({accountId:"a",cursor:1,complete:true,changes:[{cursor:1,recordType:"workout",clientId:"late",serverRevision:1,deleted:false,payload:{date:"2026-11-08",label:"Late",startedAt:null,endedAt:null}}]}));
 await run;assert.equal(listHistory(db).length,0);assert.equal(store.readSyncState(db).cursor,0);worker.stop();db.close();
});
test("worker replays an unacknowledged frozen operation before pulling and remains single flight",async()=>{
 const db=database();store.bindSync(db,"a",URL);workout(db);const frozen=store.prepareBatch(db);
 let failed=false;let pushes=0;const order:string[]=[];
 const worker=createSyncWorker({db,accountId:"a",baseUrl:URL,token:"synthetic",isCurrent:()=>true,fetchImpl:(async(url,init)=>{
  const path=String(url);order.push(path.includes("push")?"push":path.includes("pull")?"pull":"account");
  if(path.endsWith("/account")) return response({accountId:"a",cloudSyncConsent:store.CLOUD_SYNC_VERSION});
  if(path.includes("push")) {pushes++;const body=JSON.parse(String(init?.body));assert.deepEqual(body.operations,frozen);if(!failed){failed=true;throw Error("lost acknowledgment");} return response({accountId:"a",cursor:99,results:body.operations.map((op:store.SyncOperation)=>({opId:op.opId,recordType:op.recordType,clientId:op.clientId,serverRevision:1,status:"applied"}))});}
  return response({accountId:"a",cursor:0,complete:true,changes:[]});
 }) as typeof fetch});
 await Promise.all([worker.run(),worker.run()]);assert.equal(pushes,1);assert.equal(store.readSyncState(db).restored,false);
 await worker.run();assert.equal(pushes,2);assert.equal(order.indexOf("push")<order.indexOf("pull"),true);assert.equal(store.readSyncState(db).cursor,0);assert.equal(store.readSyncState(db).restored,true);worker.stop();db.close();
});

test("account backup replacement is guarded while anonymous restore and export remain available",()=>{
 const db=database();const backup=exportBackup(db,NOW);store.bindSync(db,"a",URL);
 assert.equal(restoreBackup(db,memoryFiles(),JSON.stringify(backup),NOW).ok,false);
 assert.throws(()=>applyBackup(db,backup));assert.equal(exportBackup(db,NOW).records.exercises.length,8);
 db.close();
});

test("guest association is transactional, retry-safe and leaves the source untouched",()=>{
 const guest=database(),account=database();workout(guest);store.bindSync(account,"a",URL);
 associateWorkspace(guest,account,"anonymous");associateWorkspace(guest,account,"anonymous");
 assert.equal(listHistory(account).length,1);assert.equal(listHistory(guest).length,1);
 assert.equal(account.get<{c:number}>("SELECT COUNT(*) c FROM workout_set")!.c,1);
 assert.ok(account.get("SELECT seq FROM sync_outbox WHERE client_id='w-set'"));
 assert.throws(()=>associateWorkspace(account,database(),"another-account"));guest.close();account.close();
});
test("association collisions require an explicit keep-both action and never discard either graph",()=>{
 const guest=database(),account=database();workout(guest);store.bindSync(account,"a",URL);workout(account);
 account.run("UPDATE workout_set SET load_lb='150' WHERE id='w-set'");
 assert.throws(()=>associateWorkspace(guest,account,"anonymous"),/ASSOCIATION_COLLISION/);
 assert.equal(listHistory(account).length,1);
 associateWorkspace(guest,account,"anonymous",true);
 assert.equal(listHistory(account).length,2);assert.deepEqual(account.all<{load_lb:string}>("SELECT load_lb FROM workout_set ORDER BY load_lb").map(s=>s.load_lb),["100","150"]);
 associateWorkspace(guest,account,"anonymous",true);assert.equal(listHistory(account).length,2);guest.close();account.close();
});

test("staged children cannot be accepted under a remotely deleted parent",()=>{
 const db=database();store.bindSync(db,"a",URL);
 const first={cursor:1,recordType:"workout_set" as const,clientId:"staged-set",serverRevision:1,deleted:false,payload:{workoutExerciseId:"missing-entry",position:1,loadLb:"120",reps:3,durationSec:null,assisted:false,note:null,loggedAt:NOW}};
 store.applySyncPage(db,{accountId:"a",cursor:1,complete:true,changes:[first]},NOW);
 // Soft-deleted parents still satisfy SQLite foreign keys; the sync layer must reject them.
 db.run("INSERT INTO workout(id,date,created_at,updated_at) VALUES('parent-w','2026-11-08',?,?)",[NOW,NOW]);
 db.run("INSERT INTO workout_exercise(id,workout_id,exercise_id,position,created_at,updated_at) VALUES('missing-entry','parent-w','seed-bench',1,?,?)",[NOW,NOW]);
 store.applySyncPage(db,{accountId:"a",cursor:2,complete:true,changes:[{cursor:2,recordType:"workout_exercise",clientId:"missing-entry",serverRevision:2,deleted:true,payload:null}]},NOW);
 const conflict=store.listSyncConflicts(db).find(c=>c.clientId==="staged-set")!;
 assert.equal(conflict.reason,"parent_deleted");
 store.resolveSyncConflict(db,conflict.id,"server",NOW);
 assert.equal(db.get("SELECT id FROM workout_set WHERE id='staged-set' AND deleted_at IS NULL"),undefined);db.close();
});
test("association profile selection uploads the imported version and copied exercise keeps its own name",()=>{
 const source=database(),target=database();store.bindSync(target,"a",URL);
 const draft={goal:"hypertrophy" as const,experience:null,trainingDays:4,sessionMinutes:null,equipment:null,preferences:null};
 saveTrainingProfile(source,draft,NOW);saveTrainingProfile(target,{...draft,goal:"strength"},NOW);
 source.run("UPDATE exercise SET bar_weight_lb='35' WHERE id='seed-bench'");
 assert.throws(()=>associateWorkspace(source,target,"anonymous"),/ASSOCIATION_COLLISION/);
 associateWorkspace(source,target,"anonymous",true);
 const copied=target.get<{id:string}>("SELECT id FROM exercise WHERE bar_weight_lb='35'")!;
 assert.ok(target.get("SELECT id FROM exercise_name WHERE exercise_id=? AND is_canonical=1 AND deleted_at IS NULL",[copied.id]));
 const conflict=store.listSyncConflicts(target).find(c=>c.reason==="association_profile")!;
 store.resolveSyncConflict(target,conflict.id,"local",NOW);
 assert.equal(store.localPayload(target,"training_profile","local")?.goal,"hypertrophy");
 assert.equal(store.prepareBatch(target).find(o=>o.recordType==="training_profile")?.payload?.goal,"hypertrophy");source.close();target.close();
});

test("accepting a parent conflict retries its staged descendants",()=>{
 const db=database();store.bindSync(db,"a",URL);workout(db);
 const parent={cursor:1,recordType:"workout" as const,clientId:"w",serverRevision:1,deleted:false,payload:{date:"2026-11-08",label:"Account version",startedAt:null,endedAt:null}};
 store.applySyncPage(db,{accountId:"a",cursor:2,complete:true,changes:[parent,{cursor:2,recordType:"workout_exercise",clientId:"remote-entry",serverRevision:1,deleted:false,payload:{workoutId:"w",exerciseId:"seed-row",position:2}}]},NOW);
 assert.equal(db.get("SELECT id FROM workout_exercise WHERE id='remote-entry'"),undefined);
 store.resolveSyncConflict(db,store.listSyncConflicts(db).find(c=>c.clientId==='w')!.id,"server",NOW);
 assert.ok(db.get("SELECT id FROM workout_exercise WHERE id='remote-entry'"));assert.equal(store.listSyncConflicts(db).some(c=>c.clientId==='remote-entry'),false);db.close();
});
test("remote page storage failure rolls back records, suppression flag and cursor",()=>{
 const db=database();store.bindSync(db,"a",URL);
 db.exec("CREATE TRIGGER force_test_abort BEFORE INSERT ON workout WHEN NEW.id='break-page' BEGIN SELECT RAISE(ABORT,'synthetic disk failure'); END");
 assert.throws(()=>store.applySyncPage(db,{accountId:"a",cursor:2,complete:true,changes:[{cursor:1,recordType:"workout",clientId:"first-page",serverRevision:1,deleted:false,payload:{date:"2026-11-08",label:null,startedAt:null,endedAt:null}},{cursor:2,recordType:"workout",clientId:"break-page",serverRevision:1,deleted:false,payload:{date:"2026-11-08",label:null,startedAt:null,endedAt:null}}]},NOW));
 assert.equal(db.get("SELECT id FROM workout WHERE id='first-page'"),undefined);assert.equal(store.readSyncState(db).cursor,0);assert.equal(db.get<{suppress:number}>("SELECT suppress FROM sync_state")!.suppress,0);db.close();
});
test("locally deleted parents do not send child upserts in their deletion batch",()=>{
 const db=database();store.bindSync(db,"a",URL);workout(db);
 let operations=store.prepareBatch(db);store.acknowledgeBatch(db,operations,operations.map(o=>({opId:o.opId,recordType:o.recordType,clientId:o.clientId,serverRevision:1,status:"applied"})));
 db.run("UPDATE workout_set SET reps=7 WHERE id='w-set'");db.run("UPDATE workout_exercise SET deleted_at=? WHERE id='w-entry'",[NOW]);
 operations=store.prepareBatch(db);assert.equal(operations.some(o=>o.clientId==='w-set'),false);
 store.acknowledgeBatch(db,operations,operations.map(o=>({opId:o.opId,recordType:o.recordType,clientId:o.clientId,serverRevision:2,status:"deleted"})));
 assert.ok(db.get<{deleted_at:string}>("SELECT deleted_at FROM workout_set WHERE id='w-set'")!.deleted_at);db.close();
});

test("repeated push failure accumulates recoverability diagnostics despite successful pulls",async()=>{
 const db=database();store.bindSync(db,"a",URL);workout(db);
 const worker=createSyncWorker({db,accountId:"a",baseUrl:URL,token:"synthetic",isCurrent:()=>true,fetchImpl:(async(url)=>{
  if(String(url).endsWith('/account')) return response({accountId:'a',cloudSyncConsent:store.CLOUD_SYNC_VERSION});
  if(String(url).includes('/push')) throw Error('offline during push');
  return response({accountId:'a',cursor:0,complete:true,changes:[]});
 }) as typeof fetch});
 for(let attempt=0;attempt<5;attempt++) await worker.run();
 assert.equal(store.readSyncState(db).failures,5);worker.stop();db.close();
});
test("request timeouts leave durable operations for retry and ACCOUNT_GONE stops the workspace",async()=>{
 const db=database();store.bindSync(db,"a",URL);workout(db);
 let auth=0;const timed=createSyncWorker({db,accountId:'a',baseUrl:URL,token:'synthetic',isCurrent:()=>true,timeoutMs:10,fetchImpl:(async()=>await new Promise<Response>(()=>{})) as typeof fetch});
 await timed.run();assert.equal(store.readSyncState(db).lastCode,'TIMEOUT');assert.ok(store.prepareBatch(db).length);timed.stop();
 const gone=createSyncWorker({db,accountId:'a',baseUrl:URL,token:'synthetic',isCurrent:()=>true,onAuthRequired:()=>auth++,fetchImpl:(async()=>response({code:'ACCOUNT_GONE'},410)) as typeof fetch});
 await gone.run();assert.equal(store.readSyncState(db).terminal,true);assert.equal(store.prepareBatch(db).length,0);assert.equal(auth,0);gone.stop();db.close();
});

test("a different server cannot claim a workspace by returning the same account id",()=>{
 const db=database();store.bindSync(db,"a",URL);workout(db);const before=store.prepareBatch(db);
 store.applySyncPage(db,{accountId:'a',cursor:9,complete:true,changes:[]},NOW);
 assert.throws(()=>store.rebindVerifiedAccount(db,'a','http://localhost:18087'));
 assert.equal(store.readSyncState(db).origin,URL);assert.equal(store.readSyncState(db).cursor,9);assert.deepEqual(store.prepareBatch(db),before);
 assert.throws(()=>store.rebindVerifiedAccount(db,'b',URL));store.rebindVerifiedAccount(db,'a',URL);db.close();
});

test("fresh default catalog does not conflict with a modified account exercise during restoration",()=>{
 const db=database();store.bindSync(db,'a',URL);
 const change={cursor:1,recordType:'exercise' as const,clientId:'seed-bench',serverRevision:2,deleted:false,payload:{type:'barbell',name:'Barbell Bench Press',barWeightLb:'35'}};
 store.applySyncPage(db,{accountId:'a',cursor:1,complete:true,changes:[change]},NOW);
 assert.equal(store.listSyncConflicts(db).length,0);assert.equal(store.localPayload(db,'exercise','seed-bench')?.barWeightLb,'35');
 workout(db);const batch=store.prepareBatch(db);assert.ok(batch.some(o=>o.recordType==='workout_exercise'));assert.ok(batch.some(o=>o.recordType==='exercise_name' && o.clientId==='seed-bench-name'));db.close();
});

test("timeouts also bound a response whose body never finishes",async()=>{
 const db=database();store.bindSync(db,'a',URL);
 const worker=createSyncWorker({db,accountId:'a',baseUrl:URL,token:'synthetic',isCurrent:()=>true,timeoutMs:10,fetchImpl:(async()=>new Response(new ReadableStream({start(){ /* Deliberately stalled body. */ }}),{status:200})) as typeof fetch});
 const outcome=await Promise.race([worker.run().then(()=>"settled"),new Promise(resolve=>setTimeout(()=>resolve("hung"),150))]);
 assert.equal(outcome,'settled');assert.equal(store.readSyncState(db).lastCode,'TIMEOUT');worker.stop();db.close();
});

test("version two database migration preserves history and is repeatable",()=>{
 const db=openNodeDatabase();db.exec(SCHEMA_SQL);db.run("INSERT INTO schema_meta VALUES(1,2)");
 db.run("INSERT INTO exercise VALUES('custom-old','machine',NULL,?,?,NULL)",[NOW,NOW]);
 db.run("INSERT INTO exercise_name VALUES('custom-old-name','custom-old','Old Press','old press',1,?,?,NULL)",[NOW,NOW]);
 db.run("INSERT INTO workout(id,date,label,created_at,updated_at) VALUES('old-workout','2026-11-07','Preserved',?,?)",[NOW,NOW]);
 const before=exportBackup(db,NOW).records;migrate(db,NOW);migrate(db,NOW);
 assert.deepEqual(exportBackup(db,NOW).records,before);assert.equal(db.get<{version:number}>("SELECT version FROM schema_meta")!.version,3);
 store.bindSync(db,'a',URL);assert.ok(store.prepareBatch(db).some(o=>o.clientId==='old-workout'));db.close();
});
test("explicit open-session and duplicate-entry repairs preserve both workout graphs",()=>{
 const db=database();store.bindSync(db,'a',URL);startWorkout(db,{actionId:'local-open',label:'Phone session',now:NOW,localDate:'2026-11-08'});
 store.applySyncPage(db,{accountId:'a',cursor:1,complete:true,changes:[{cursor:1,recordType:'workout',clientId:'remote-open',serverRevision:1,deleted:false,payload:{date:'2026-11-08',label:'Account session',startedAt:NOW,endedAt:null}}]},NOW);
 const open=store.listSyncConflicts(db).find(c=>c.clientId==='remote-open')!;assert.equal(open.reason,'local_constraint');repairSyncConflict(db,open.id,'finish',undefined,NOW);
 assert.equal(db.get<{ended_at:string}>("SELECT ended_at FROM workout WHERE id='local-open'")!.ended_at,NOW);
 assert.equal(db.get<{ended_at:null}>("SELECT ended_at FROM workout WHERE id='remote-open'")!.ended_at,null);
 finishWorkout(db,'remote-open',NOW);workout(db,'dup');
 store.applySyncPage(db,{accountId:'a',cursor:2,complete:true,changes:[{cursor:2,recordType:'workout_exercise',clientId:'duplicate-entry',serverRevision:1,deleted:false,payload:{workoutId:'dup',exerciseId:'seed-bench',position:2}}]},NOW);
 const entry=store.listSyncConflicts(db).find(c=>c.clientId==='duplicate-entry')!;repairSyncConflict(db,entry.id,'separate',undefined,NOW);
 assert.equal(db.get<{workout_id:string}>("SELECT workout_id FROM workout_exercise WHERE id='duplicate-entry'")!.workout_id,'dup');
 assert.notEqual(db.get<{workout_id:string}>("SELECT workout_id FROM workout_exercise WHERE id='dup-entry'")!.workout_id,'dup');
 assert.equal(db.get<{c:number}>("SELECT COUNT(*) c FROM workout_set WHERE deleted_at IS NULL")!.c,1);db.close();
});
test("explicit alias collision repair keeps the phone identity and account identity",()=>{
 const db=database();store.bindSync(db,'a',URL);
 store.applySyncPage(db,{accountId:'a',cursor:2,complete:true,changes:[{cursor:1,recordType:'exercise',clientId:'other-bench',serverRevision:1,deleted:false,payload:{type:'machine',name:'Barbell Bench Press',barWeightLb:null}},{cursor:2,recordType:'exercise_name',clientId:'other-bench-name',serverRevision:1,deleted:false,payload:{exerciseId:'other-bench',name:'Barbell Bench Press',canonical:true}}]},NOW);
 const conflict=store.listSyncConflicts(db).find(c=>c.clientId==='other-bench-name')!;assert.equal(conflict.reason,'local_constraint');repairSyncConflict(db,conflict.id,'rename','Phone Bench',NOW);
 assert.equal(store.localPayload(db,'exercise_name','seed-bench-name')?.name,'Phone Bench');assert.equal(store.localPayload(db,'exercise_name','other-bench-name')?.name,'Barbell Bench Press');db.close();
});

test("an alias for an untouched seed queues its required parent definition",()=>{
 const db=database();store.bindSync(db,'a',URL);
 db.run("INSERT INTO exercise_name(id,exercise_id,display_name,normalized_name,is_canonical,created_at,updated_at) VALUES('bench-alias','seed-bench','Bench','bench',0,?,?)",[NOW,NOW]);
 const operations=store.prepareBatch(db);assert.ok(operations.some(o=>o.recordType==='exercise' && o.clientId==='seed-bench'));assert.ok(operations.some(o=>o.clientId==='bench-alias'));assert.ok(operations.some(o=>o.clientId==='seed-bench-name'));db.close();
});

test("a frozen child rejected for a missing parent still pulls the parent tombstone",async()=>{
 const db=database();store.bindSync(db,'a',URL);workout(db);
 const initial=store.prepareBatch(db);store.acknowledgeBatch(db,initial,initial.map(o=>({opId:o.opId,recordType:o.recordType,clientId:o.clientId,serverRevision:1,status:'applied'})));
 db.run("UPDATE workout_set SET reps=9 WHERE id='w-set'");store.prepareBatch(db);
 let pulled=false;const worker=createSyncWorker({db,accountId:'a',baseUrl:URL,token:'synthetic',isCurrent:()=>true,fetchImpl:(async(url)=>{
  if(String(url).endsWith('/account')) return response({accountId:'a',cloudSyncConsent:store.CLOUD_SYNC_VERSION});
  if(String(url).includes('/push')) return response({code:'PARENT_NOT_FOUND'},409);
  pulled=true;return response({accountId:'a',cursor:1,complete:true,changes:[{cursor:1,recordType:'workout_exercise',clientId:'w-entry',serverRevision:2,deleted:true,payload:null}]});
 }) as typeof fetch});
 await worker.run();assert.equal(pulled,true);assert.equal(store.readSyncState(db).lastCode,null);assert.ok(db.get<{deleted_at:string}>("SELECT deleted_at FROM workout_set WHERE id='w-set'")!.deleted_at);assert.ok(store.listSyncConflicts(db).some(c=>c.clientId==='w-set' && c.localPayload?.reps===9));worker.stop();db.close();
});
