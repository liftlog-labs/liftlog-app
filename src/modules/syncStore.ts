import { normalizeServerUrl } from "./accountSession";
import { SEED } from "../storage/schema";
import { sha256Hex } from "../shared/digest";
import { SYNC_TYPES, type SyncType } from "../storage/syncSchema";
import type { SqlExecutor } from "../storage/sql";
import { applyChange, type SyncChange } from "./syncApply";

export const CLOUD_SYNC_VERSION = "2026-11-05";
export type SyncOperation = { opId:string; recordType:SyncType; clientId:string; kind:"upsert"|"delete"; payload:Record<string,unknown>|null; baseRevision:number; fingerprint:string };
export type SyncPage = {accountId:string; cursor:number; complete:boolean; changes:SyncChange[]};
export type SyncResult = {opId:string; recordType:SyncType; clientId:string; serverRevision:number; status:string};
export type SyncConflict = {id:number; recordType:SyncType; clientId:string; reason:string; localPayload:Record<string,unknown>|null; remote:SyncChange};
type OutboxRow = {seq:number; op_id:string; record_type:SyncType; client_id:string; kind:"upsert"|"delete"; payload:string|null; base_revision:number|null; fingerprint:string|null; blocked:number};
type Shadow = {record_type:SyncType; client_id:string; revision:number; deleted:number; payload:string|null; applied:number};
type StateRow = {account_id:string|null; origin:string|null; cursor:number; restored:number; consent:string|null; terminal:number; failures:number; last_code:string|null; local_version:number};
export function readSyncState(db:SqlExecutor) {
  const row=db.get<StateRow>("SELECT * FROM sync_state WHERE id=1");
  if(!row) throw Error("Sync storage missing");
  return {accountId:row.account_id,origin:row.origin,cursor:row.cursor,restored:row.restored===1,consent:row.consent,terminal:row.terminal===1 || !!db.get("SELECT value FROM preference WHERE key='sync_account_deletion' AND value IN ('pending','confirmed')"),failures:row.failures,lastCode:row.last_code,localVersion:row.local_version};
}
export function canonicalJson(value:unknown):string {
  if(Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if(value && typeof value==="object") return `{${Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>`${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}
export function bindSync(db:SqlExecutor,accountId:string,baseUrl:string):void {
  const origin=normalizeServerUrl(baseUrl);
  if(!accountId || !/^https?:\/\//.test(origin)) throw Error("Invalid sync binding");
  const state=readSyncState(db);
  if(state.terminal) throw Error("Account workspace is quarantined");
  if(state.accountId && (state.accountId!==accountId || state.origin!==origin)) throw Error("Sync workspace mismatch");
  if(state.accountId) return;
  db.transaction(()=>{
    db.run("UPDATE sync_state SET account_id=?,origin=? WHERE id=1",[accountId,origin]);
    for(const type of SYNC_TYPES) {
      for(const row of db.all<{id:string}>(`SELECT id FROM ${type} ORDER BY id`)) {
        const payload=localPayload(db,type,row.id);
        const seed=SEED.find(seed=>type==="exercise"?seed.id===row.id:type==="exercise_name"?`${seed.id}-name`===row.id:false);
        if(seed && payload && (type==="exercise"
          ? payload.type===seed.type && payload.name===seed.name && payload.barWeightLb===seed.bar
          : payload.name===seed.name && payload.exerciseId===seed.id && payload.canonical===true)) continue;
        queue(db,type,row.id,payload);
      }
    }
  });
}
export function withRemoteWrites<T>(db:SqlExecutor,work:()=>T):T {
  db.run("UPDATE sync_state SET suppress=1 WHERE id=1");
  try {return work();} finally {db.run("UPDATE sync_state SET suppress=0 WHERE id=1");}
}
export function localPayload(db:SqlExecutor,type:SyncType,id:string):Record<string,unknown>|null {
  const row=db.get<Record<string,unknown>>(`SELECT * FROM ${type} WHERE id=?`,[id]);
  if(!row || row.deleted_at) return null;
  switch(type) {
    case "exercise": return {type:row.type,name:db.get<{display_name:string}>("SELECT display_name FROM exercise_name WHERE exercise_id=? AND is_canonical=1 AND deleted_at IS NULL LIMIT 1",[id])?.display_name ?? id,barWeightLb:row.bar_weight_lb};
    case "exercise_name":return {exerciseId:row.exercise_id,name:row.display_name,canonical:row.is_canonical===1};
    case "workout":return {date:row.date,label:row.label,startedAt:row.started_at,endedAt:row.ended_at};
    case "workout_exercise":return {workoutId:row.workout_id,exerciseId:row.exercise_id,position:row.position};
    case "workout_set":return {workoutExerciseId:row.workout_exercise_id,position:row.position,loadLb:row.load_lb,reps:row.reps,durationSec:row.duration_sec,assisted:row.assisted===1,note:row.note,loggedAt:row.logged_at};
    case "training_profile":return {goal:row.goal,experience:row.experience,trainingDays:row.training_days,sessionMinutes:row.session_minutes,equipment:row.equipment_json===null?null:JSON.parse(String(row.equipment_json)),preferences:row.preferences_json===null?null:JSON.parse(String(row.preferences_json))};
  }
}
export function queue(db:SqlExecutor,type:SyncType,id:string,payload:Record<string,unknown>|null):void {
  db.run("INSERT INTO sync_outbox(op_id,record_type,client_id,kind,payload) VALUES(lower(hex(randomblob(16))),?,?,?,?)",[type,id,payload===null?"delete":"upsert",payload===null?null:JSON.stringify(payload)]);
}
function shadow(db:SqlExecutor,type:SyncType,id:string):Shadow|undefined {return db.get<Shadow>("SELECT * FROM sync_shadow WHERE record_type=? AND client_id=?",[type,id]);}
function pending(db:SqlExecutor,type:SyncType,id:string):boolean {return !!db.get("SELECT seq FROM sync_outbox WHERE record_type=? AND client_id=? LIMIT 1",[type,id]);}
function conflicted(db:SqlExecutor,type:SyncType,id:string):boolean {return !!db.get("SELECT id FROM sync_conflict WHERE record_type=? AND client_id=? AND resolved=0 LIMIT 1",[type,id]);}
function parents(type:SyncType,payload:Record<string,unknown>|null):[SyncType,string][] {
  if(!payload) return [];
  if(type==="exercise_name") return [["exercise",String(payload.exerciseId)]];
  if(type==="workout_exercise") return [["workout",String(payload.workoutId)],["exercise",String(payload.exerciseId)]];
  if(type==="workout_set") return [["workout_exercise",String(payload.workoutExerciseId)]];
  return [];
}
function operation(row:OutboxRow):SyncOperation {
  return {opId:row.op_id,recordType:row.record_type,clientId:row.client_id,kind:row.kind,payload:row.payload===null?null:JSON.parse(row.payload),baseRevision:row.base_revision!,fingerprint:row.fingerprint!};
}
export function prepareBatch(db:SqlExecutor):SyncOperation[] {
  if(readSyncState(db).terminal) return [];
  return db.transaction(()=>{
    const frozen=db.all<OutboxRow>("SELECT * FROM sync_outbox WHERE fingerprint IS NOT NULL AND blocked=0 ORDER BY CASE record_type WHEN 'exercise' THEN 0 WHEN 'exercise_name' THEN 1 WHEN 'workout' THEN 2 WHEN 'workout_exercise' THEN 3 WHEN 'workout_set' THEN 4 ELSE 5 END,seq LIMIT 50");
    if(frozen.length) return frozen.map(operation);
    ensureCatalogDependencies(db);
    // Coalesce only operations that have never been sent. Frozen requests are immutable.
    db.run(`DELETE FROM sync_outbox WHERE fingerprint IS NULL AND blocked=0 AND seq NOT IN
      (SELECT MAX(seq) FROM sync_outbox WHERE fingerprint IS NULL AND blocked=0 GROUP BY record_type,client_id)`);
    const candidates=db.all<OutboxRow>("SELECT * FROM sync_outbox WHERE fingerprint IS NULL AND blocked=0 ORDER BY CASE record_type WHEN 'exercise' THEN 0 WHEN 'exercise_name' THEN 1 WHEN 'workout' THEN 2 WHEN 'workout_exercise' THEN 3 WHEN 'workout_set' THEN 4 ELSE 5 END,seq");
    const selected:SyncOperation[]=[];
    const ready=new Set<string>();
    for(const row of candidates) {
      if(selected.length===50) break;
      if(conflicted(db,row.record_type,row.client_id)) continue;
      const current=shadow(db,row.record_type,row.client_id);
      if(current?.deleted && row.kind==="upsert") {db.run("UPDATE sync_outbox SET blocked=1 WHERE seq=?",[row.seq]);continue;}
      const payload=row.payload===null?null:JSON.parse(row.payload);
      if(unavailableAncestor(db,row.record_type,payload) || parents(row.record_type,payload).some(([type,id])=> {
        if(conflicted(db,type,id)) return true;
        const parent=shadow(db,type,id);
        return !ready.has(`${type}:${id}`) && (!parent || parent.deleted || !parent.applied || pending(db,type,id));
      })) continue;
      const body={recordType:row.record_type,clientId:row.client_id,kind:row.kind,payload,baseRevision:current?.revision ?? 0};
      const fingerprint=sha256Hex(canonicalJson(body));
      db.run("UPDATE sync_outbox SET base_revision=?,fingerprint=? WHERE seq=?",[body.baseRevision,fingerprint,row.seq]);
      selected.push({...body,opId:row.op_id,fingerprint});
      if(row.kind==="upsert") ready.add(`${row.record_type}:${row.client_id}`);
    }
    return selected;
  });
}
function saveShadow(db:SqlExecutor,change:SyncChange,applied:boolean):void {
  db.run(`INSERT INTO sync_shadow(record_type,client_id,revision,deleted,payload,applied) VALUES(?,?,?,?,?,?)
   ON CONFLICT(record_type,client_id) DO UPDATE SET revision=excluded.revision,deleted=excluded.deleted,payload=excluded.payload,applied=excluded.applied
   WHERE excluded.revision>=sync_shadow.revision`,[change.recordType,change.clientId,change.serverRevision,change.deleted?1:0,change.payload===null?null:JSON.stringify(change.payload),applied?1:0]);
}
export function acknowledgeBatch(db:SqlExecutor,operations:SyncOperation[],results:SyncResult[]):void {
  if(results.length!==operations.length) throw Error("Invalid push receipt");
  for(const op of operations) {
    const result=results.find(r=>r.opId===op.opId);
    if(!result || result.recordType!==op.recordType || result.clientId!==op.clientId || !Number.isSafeInteger(result.serverRevision) || result.serverRevision<1 || !["applied","deleted"].includes(result.status)) throw Error("Invalid push receipt");
  }
  db.transaction(()=>withRemoteWrites(db,()=>{
    for(const op of operations) {
      const result=results.find(r=>r.opId===op.opId)!;
      saveShadow(db,{cursor:0,recordType:op.recordType,clientId:op.clientId,serverRevision:result.serverRevision,deleted:result.status==="deleted",payload:op.payload},true);
      if(result.status==="deleted") {
        const change:SyncChange={cursor:0,recordType:op.recordType,clientId:op.clientId,serverRevision:result.serverRevision,deleted:true,payload:null};
        deletedDescendants(db,change,new Date().toISOString());
        applyChange(db,change,new Date().toISOString());
      }
      db.run("DELETE FROM sync_outbox WHERE op_id=?",[op.opId]);
    }
  }));
}
function saveConflict(db:SqlExecutor,change:SyncChange,reason:string,local=localPayload(db,change.recordType,change.clientId)):void {
  const encoded=JSON.stringify(change);
  if(!db.get("SELECT id FROM sync_conflict WHERE record_type=? AND client_id=? AND remote_change=? AND local_payload IS ? AND resolved=0",[change.recordType,change.clientId,encoded,local===null?null:JSON.stringify(local)])) {
    db.run("INSERT INTO sync_conflict(record_type,client_id,reason,local_payload,remote_change) VALUES(?,?,?,?,?)",[change.recordType,change.clientId,reason,local===null?null:JSON.stringify(local),encoded]);
  }
  db.run("UPDATE sync_outbox SET blocked=1 WHERE record_type=? AND client_id=?",[change.recordType,change.clientId]);
}
export function listSyncConflicts(db:SqlExecutor):SyncConflict[] {
  return db.all<{id:number;record_type:SyncType;client_id:string;reason:string;local_payload:string|null;remote_change:string}>(`SELECT * FROM sync_conflict WHERE id IN
    (SELECT MAX(id) FROM sync_conflict WHERE resolved=0 GROUP BY record_type,client_id) ORDER BY id`).map(row=>({id:row.id,recordType:row.record_type,clientId:row.client_id,reason:row.reason,localPayload:row.local_payload===null?null:JSON.parse(row.local_payload),remote:JSON.parse(row.remote_change)}));
}
function deletedDescendants(db:SqlExecutor,change:SyncChange,now:string):void {
  // Also cover downloaded descendants that could not yet be materialized because of a conflict.
  for(const row of db.all<Shadow>("SELECT * FROM sync_shadow WHERE applied=0 AND deleted=0 AND payload IS NOT NULL")) {
    const payload=JSON.parse(row.payload!);
    if(!parents(row.record_type,payload).some(([type,id])=>type===change.recordType && id===change.clientId)) continue;
    const child:SyncChange={cursor:change.cursor,recordType:row.record_type,clientId:row.client_id,serverRevision:row.revision,deleted:true,payload:null};
    saveConflict(db,child,"parent_deleted");
    deletedDescendants(db,child,now);
    applyChange(db,child,now);
  }
  const children:[SyncType,string][]=[];
  if(change.recordType==="workout") children.push(...db.all<{id:string}>("SELECT id FROM workout_exercise WHERE workout_id=? AND deleted_at IS NULL",[change.clientId]).map(r=>["workout_exercise",r.id] as [SyncType,string]));
  if(change.recordType==="exercise") {
    children.push(...db.all<{id:string}>("SELECT id FROM exercise_name WHERE exercise_id=? AND deleted_at IS NULL",[change.clientId]).map(r=>["exercise_name",r.id] as [SyncType,string]));
    children.push(...db.all<{id:string}>("SELECT id FROM workout_exercise WHERE exercise_id=? AND deleted_at IS NULL",[change.clientId]).map(r=>["workout_exercise",r.id] as [SyncType,string]));
  }
  if(change.recordType==="workout_exercise") children.push(...db.all<{id:string}>("SELECT id FROM workout_set WHERE workout_exercise_id=? AND deleted_at IS NULL",[change.clientId]).map(r=>["workout_set",r.id] as [SyncType,string]));
  for(const [type,id] of children) {
    const child={...change,recordType:type,clientId:id,serverRevision:shadow(db,type,id)?.revision ?? 0};
    saveConflict(db,child,"parent_deleted");
    deletedDescendants(db,child,now);
    applyChange(db,child,now);
    // These are local effective deletions, not fabricated server revisions.
    db.run("UPDATE sync_outbox SET blocked=1 WHERE record_type=? AND client_id=?",[type,id]);
  }
}
function stageChange(db:SqlExecutor,change:SyncChange,now:string):void {
  const previous=shadow(db,change.recordType,change.clientId);
  if(previous && (previous.revision>change.serverRevision || (previous.revision===change.serverRevision && previous.applied))) return;
  const local=localPayload(db,change.recordType,change.clientId);
  const dirty=pending(db,change.recordType,change.clientId);
  if(change.deleted) {
    if(dirty && local!==null) saveConflict(db,change,"deleted",local);
    db.run("DELETE FROM sync_outbox WHERE record_type=? AND client_id=? AND blocked=0",[change.recordType,change.clientId]);
    deletedDescendants(db,change,now);
    applyChange(db,change,now);
    saveShadow(db,change,true);
    return;
  }
  if(previous?.deleted) return;
  const same=canonicalJson(local)===canonicalJson(change.payload);
  if(dirty && !same) {
    saveConflict(db,change,"concurrent_edit",local);
    saveShadow(db,change,false);
    return;
  }
  if(dirty && same) db.run("DELETE FROM sync_outbox WHERE record_type=? AND client_id=? AND fingerprint IS NULL",[change.recordType,change.clientId]);
  if(deletedAncestor(db,change.recordType,change.payload)) {
    saveShadow(db,change,false);
    const effective={...change,deleted:true,payload:null};
    saveConflict(db,effective,"parent_deleted",local);
    deletedDescendants(db,effective,now);applyChange(db,effective,now);return;
  }
  if(unavailableAncestor(db,change.recordType,change.payload) || parents(change.recordType,change.payload).some(([type,id])=> {
    const parent=shadow(db,type,id);
    return conflicted(db,type,id) || !!parent?.deleted || !localPayload(db,type,id);
  })) {
    saveConflict(db,change,"parent_unavailable",local);
    saveShadow(db,change,false);return;
  }
  db.exec("SAVEPOINT apply_sync_record");
  try {
    applyChange(db,change,now);
    db.exec("RELEASE apply_sync_record");
    saveShadow(db,change,true);
  } catch(error) {
    db.exec("ROLLBACK TO apply_sync_record");db.exec("RELEASE apply_sync_record");
    // Only constraint failures are representable conflicts; storage failures roll back the page.
    if(!/constraint|UNIQUE|FOREIGN KEY|CHECK/i.test(String(error))) throw error;
    saveConflict(db,change,"local_constraint",local);saveShadow(db,change,false);
  }
}
export function applySyncPage(db:SqlExecutor,page:SyncPage,now=new Date().toISOString()):void {
  const state=readSyncState(db);
  if(state.terminal) throw Error("Account workspace is quarantined");
  if(page.accountId!==state.accountId || !Number.isSafeInteger(page.cursor) || page.cursor<state.cursor || typeof page.complete!=="boolean" || !Array.isArray(page.changes) || page.changes.length>200) throw Error("Invalid sync page");
  let cursor=state.cursor;
  for(const change of page.changes) {
    if(!SYNC_TYPES.includes(change.recordType) || typeof change.clientId!=="string" || !change.clientId || !Number.isSafeInteger(change.cursor) || change.cursor<=cursor || change.cursor>page.cursor || !Number.isSafeInteger(change.serverRevision) || change.serverRevision<1 || typeof change.deleted!=="boolean" || (change.deleted?change.payload!==null:!change.payload || typeof change.payload!=="object" || Array.isArray(change.payload))) throw Error("Invalid sync change");
    cursor=change.cursor;
  }
  if(!page.complete && (!page.changes.length || page.cursor===state.cursor)) throw Error("Sync page did not advance");
  db.transaction(()=>withRemoteWrites(db,()=>{
    for(const change of page.changes) stageChange(db,change,now);
    db.run("UPDATE sync_state SET cursor=?,restored=? WHERE id=1",[page.cursor,page.complete?1:0]);
  }));
}
export function resetPullCursor(db:SqlExecutor):void {db.run("UPDATE sync_state SET cursor=0,restored=0 WHERE id=1");}
export function recordPushConflicts(db:SqlExecutor,operations:SyncOperation[],conflicts:{opId:string;code:string;server:Omit<SyncChange,"cursor">|null}[],now=new Date().toISOString()):void {
  if(!Array.isArray(conflicts) || !conflicts.length) throw Error("Invalid conflict response");
  db.transaction(()=>withRemoteWrites(db,()=>{
    for(const conflict of conflicts) {
      const op=operations.find(o=>o.opId===conflict.opId); if(!op) throw Error("Unknown conflict");
      const remote:SyncChange=conflict.server?{...conflict.server,cursor:0}:{cursor:0,recordType:op.recordType,clientId:op.clientId,serverRevision:0,deleted:false,payload:null};
      if(remote.recordType!==op.recordType || remote.clientId!==op.clientId) throw Error("Invalid conflict identity");
      saveConflict(db,remote,conflict.code,localPayload(db,op.recordType,op.clientId));
      if(conflict.server) {saveShadow(db,remote,false);if(remote.deleted) {deletedDescendants(db,remote,now);applyChange(db,remote,now);saveShadow(db,remote,true);}}
    }
    // The entire server batch rolled back. Non-conflicting operations can be safely prepared again.
    for(const op of operations) if(!conflicts.some(c=>c.opId===op.opId)) db.run("UPDATE sync_outbox SET fingerprint=NULL,base_revision=NULL WHERE op_id=?",[op.opId]);
  }));
}
export function resolveSyncConflict(db:SqlExecutor,id:number,choice:"server"|"local",now=new Date().toISOString()):void {
  const conflict=listSyncConflicts(db).find(c=>c.id===id);if(!conflict) throw Error("Conflict no longer current");
  if(choice==="local" && (conflict.remote.deleted || conflict.reason==="parent_deleted" || conflict.reason==="SUPPRESSED" || conflict.reason==="local_constraint" || conflict.reason==="parent_unavailable")) throw Error("This record needs its account version or parent resolved first");
  db.transaction(()=>withRemoteWrites(db,()=>{
    const {recordType:type,clientId}=conflict;
    const current=conflict.reason==="association_profile"?conflict.localPayload:localPayload(db,type,clientId);
    if(canonicalJson(current)!==canonicalJson(conflict.localPayload) && current!==null) {
      db.run("INSERT INTO sync_conflict(record_type,client_id,reason,local_payload,remote_change,resolved) VALUES(?,?,?,?,?,1)",[type,clientId,"resolution_archive",JSON.stringify(current),JSON.stringify(conflict.remote)]);
    }
    db.run("DELETE FROM sync_outbox WHERE record_type=? AND client_id=?",[type,clientId]);
    if(choice==="server") {
      if(!conflict.remote.deleted && (unavailableAncestor(db,type,conflict.remote.payload) || parents(type,conflict.remote.payload).some(([parentType,parentId])=>!localPayload(db,parentType,parentId) || shadow(db,parentType,parentId)?.deleted || conflicted(db,parentType,parentId)))) throw Error("Resolve the parent record first");
      if(conflict.reason==="SUPPRESSED" && !conflict.remote.payload) {
        const suppressed={...conflict.remote,deleted:true,payload:null};
        deletedDescendants(db,suppressed,now);applyChange(db,suppressed,now);saveShadow(db,suppressed,true);
      } else if(conflict.remote.payload || conflict.remote.deleted) {
        // Constraint failures roll back the action and keep both versions for a later decision.
        applyChange(db,conflict.remote,now); saveShadow(db,conflict.remote,true);
      }
    } else {
      if(conflict.reason==="association_profile" && current) applyChange(db,{...conflict.remote,deleted:false,payload:current},now);
      queue(db,type,clientId,current);
      const remote=shadow(db,type,clientId);if(remote) db.run("UPDATE sync_shadow SET applied=1 WHERE record_type=? AND client_id=?",[type,clientId]);
    }
    db.run("UPDATE sync_conflict SET resolved=1 WHERE record_type=? AND client_id=?",[type,clientId]);
    retryStagedChildren(db,now);
    db.run("UPDATE sync_state SET local_version=local_version+1 WHERE id=1");
  }));
}

function retryStagedChildren(db:SqlExecutor,now:string):void {
  for(let pass=0;pass<3;pass++) {
    let applied=0;
    for(const conflict of listSyncConflicts(db).filter(c=>c.reason==="parent_unavailable")) {
      if(parents(conflict.recordType,conflict.remote.payload).some(([type,id])=>!localPayload(db,type,id) || shadow(db,type,id)?.deleted || conflicted(db,type,id))) continue;
      stageChange(db,conflict.remote,now);
      if(shadow(db,conflict.recordType,conflict.clientId)?.applied) {
        db.run("UPDATE sync_conflict SET resolved=1 WHERE record_type=? AND client_id=? AND reason='parent_unavailable'",[conflict.recordType,conflict.clientId]);applied++;
      }
    }
    if(!applied) break;
  }
}

function unavailableAncestor(db:SqlExecutor,type:SyncType,payload:Record<string,unknown>|null,seen=new Set<string>()):boolean {
  return parents(type,payload).some(([parentType,id])=>{
    const key=`${parentType}:${id}`;if(seen.has(key)) return true;seen.add(key);
    const parent=localPayload(db,parentType,id);
    return !parent || !!shadow(db,parentType,id)?.deleted || conflicted(db,parentType,id) || unavailableAncestor(db,parentType,parent,seen);
  });
}

// Only call after an explicit successful login returned this exact account id from the new address.
// A URL alias may change; the stable account UUID, receipts and revisions still identify the account.
export function rebindVerifiedAccount(db:SqlExecutor,accountId:string,baseUrl:string):void {
 const state=readSyncState(db);const origin=normalizeServerUrl(baseUrl);
 if(state.accountId!==accountId || state.terminal || state.origin!==origin) throw Error("Account server is pinned; a verified environment migration is required");
}

function ensureCatalogDependencies(db:SqlExecutor):void {
 const ids=new Set<string>();
 for(const row of db.all<OutboxRow>("SELECT * FROM sync_outbox WHERE kind='upsert' AND blocked=0 AND record_type IN ('workout_exercise','exercise_name','training_profile')")) {
  const payload=JSON.parse(row.payload!);
  if(row.record_type==='workout_exercise' || row.record_type==='exercise_name') ids.add(payload.exerciseId);
  if(Array.isArray(payload.preferences)) for(const preference of payload.preferences) if(typeof preference?.exerciseId==='string') ids.add(preference.exerciseId);
 }
 for(const id of ids) {
  if(!shadow(db,'exercise',id) && !pending(db,'exercise',id)) {
   const payload=localPayload(db,'exercise',id);if(payload) queue(db,'exercise',id,payload);
  }
  for(const name of db.all<{id:string}>("SELECT id FROM exercise_name WHERE exercise_id=? AND deleted_at IS NULL",[id])) {
   if(!shadow(db,'exercise_name',name.id) && !pending(db,'exercise_name',name.id)) queue(db,'exercise_name',name.id,localPayload(db,'exercise_name',name.id));
  }
 }
}

function deletedAncestor(db:SqlExecutor,type:SyncType,payload:Record<string,unknown>|null):boolean {
 return parents(type,payload).some(([parentType,id])=> {
  if(shadow(db,parentType,id)?.deleted) return true;
  const row=db.get<Record<string,unknown>>(`SELECT * FROM ${parentType} WHERE id=?`,[id]);
  if(row?.deleted_at) return true;
  const parent=localPayload(db,parentType,id);
  return parent ? deletedAncestor(db,parentType,parent) : false;
 });
}
