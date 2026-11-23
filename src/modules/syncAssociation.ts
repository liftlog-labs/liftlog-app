import { sha256Hex } from "../shared/digest";
import { normalizeName } from "../shared/names";
import { SYNC_TYPES, type SyncType } from "../storage/syncSchema";
import type { SqlExecutor } from "../storage/sql";
import { canonicalJson, localPayload, queue, readSyncState } from "./syncStore";

type Row=Record<string,unknown>&{id:string};
export function associateWorkspace(source:SqlExecutor,target:SqlExecutor,sourceKey:string,keepBoth=false):void {
 const state=readSyncState(target);
 if(!state.accountId || state.terminal || readSyncState(source).accountId || source.get("SELECT value FROM preference WHERE key='workspace_bound_account'")) throw Error("ASSOCIATION_NOT_ALLOWED");
 if(target.get("SELECT source FROM sync_association WHERE source=?",[sourceKey])) return;
 const snapshots=new Map<SyncType,Row[]>(SYNC_TYPES.map(type=>[type,source.all<Row>(`SELECT * FROM ${type} ORDER BY id`)]));
 const mapping=new Map<string,string>();const reuse=new Set<string>();let collision=false;
 for(const type of SYNC_TYPES.filter(t=>t!=="training_profile")) {
   for(const row of snapshots.get(type)!) {
     const key=`${type}:${row.id}`;
     const existing=target.get<Row>(`SELECT * FROM ${type} WHERE id=?`,[row.id]);
     const tombstone=target.get<{deleted:number}>("SELECT deleted FROM sync_shadow WHERE record_type=? AND client_id=?",[type,row.id])?.deleted;
     const same=existing && canonicalJson(localPayload(source,type,row.id))===canonicalJson(localPayload(target,type,row.id)) && !tombstone;
     // Only equivalent catalog records can safely share identities across two existing logs.
     if(same && (type==="exercise" || type==="exercise_name")) reuse.add(key);
     else if(existing || tombstone) collision=true;
     mapping.set(key,row.id);
   }
 }
 // Name collisions also require an explicit keep-both choice; never INSERT OR IGNORE.
 for(const name of snapshots.get("exercise_name")!) {
   if(name.deleted_at || reuse.has(`exercise_name:${name.id}`)) continue;
   if(target.get("SELECT id FROM exercise_name WHERE normalized_name=? AND deleted_at IS NULL",[name.normalized_name])) collision=true;
 }
 for(const name of snapshots.get("exercise_name")!) {
   if(!reuse.has(`exercise:${name.exercise_id}`)) reuse.delete(`exercise_name:${name.id}`);
 }
 if(collision && !keepBoth) throw Error("ASSOCIATION_COLLISION");
 if(keepBoth && collision) {
   for(const type of SYNC_TYPES.filter(t=>t!=="training_profile")) for(const row of snapshots.get(type)!) {
     const key=`${type}:${row.id}`;if(!reuse.has(key)) mapping.set(key,`associated-${sha256Hex(`${sourceKey}:${key}`).slice(0,32)}`);
   }
 }
 const sourceOpen=snapshots.get("workout")!.some(r=>!r.deleted_at && r.started_at && !r.ended_at);
 if(sourceOpen && target.get("SELECT id FROM workout WHERE deleted_at IS NULL AND started_at IS NOT NULL AND ended_at IS NULL")) throw Error("FINISH_WORKOUT_BEFORE_ASSOCIATION");
 target.transaction(()=>{
   if(target.get("SELECT source FROM sync_association WHERE source=?",[sourceKey])) return;
   const mapped=(type:SyncType,id:unknown)=>mapping.get(`${type}:${id}`) ?? id;
   for(const type of SYNC_TYPES.filter(t=>t!=="training_profile")) for(const original of snapshots.get(type)!) {
     if(reuse.has(`${type}:${original.id}`)) continue;
     const row:Row={...original,id:String(mapped(type,original.id))};
     if(type==="exercise_name") {
       row.exercise_id=mapped("exercise",row.exercise_id);
       if(!row.deleted_at && target.get("SELECT id FROM exercise_name WHERE normalized_name=? AND deleted_at IS NULL",[row.normalized_name])) {
         row.display_name=`${row.display_name} (local ${sha256Hex(sourceKey+original.id).slice(0,6)})`;
         row.normalized_name=normalizeName(String(row.display_name));
       }
     }
     if(type==="workout_exercise") {row.workout_id=mapped("workout",row.workout_id);row.exercise_id=mapped("exercise",row.exercise_id);}
     if(type==="workout_set") row.workout_exercise_id=mapped("workout_exercise",row.workout_exercise_id);
     const columns=Object.keys(row);
     target.run(`INSERT INTO ${type}(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`,columns.map(c=>row[c]));
   }
   const profile=snapshots.get("training_profile")![0];
   if(profile) {
     const payload=localPayload(source,"training_profile","local")!;
     if(Array.isArray(payload.preferences)) payload.preferences=payload.preferences.map((p:Record<string,unknown>)=>({...p,exerciseId:mapped("exercise",p.exerciseId)}));
     const current=localPayload(target,"training_profile","local");
     const remote=target.get<{revision:number;deleted:number;payload:string|null}>("SELECT * FROM sync_shadow WHERE record_type='training_profile' AND client_id='local'");
     if(!current && !remote?.deleted) {
       const columns=Object.keys(profile);const row:Row={...profile,preferences_json:payload.preferences===null?null:JSON.stringify(payload.preferences)};
       target.run(`INSERT INTO training_profile(${columns.join(",")}) VALUES(${columns.map(()=>"?").join(",")})`,columns.map(c=>row[c]));
     } else if(canonicalJson(current)!==canonicalJson(payload)) {
       const change={cursor:0,recordType:"training_profile",clientId:"local",serverRevision:remote?.revision??0,deleted:!!remote?.deleted,payload:current};
       target.run("INSERT INTO sync_conflict(record_type,client_id,reason,local_payload,remote_change) VALUES('training_profile','local','association_profile',?,?)",[JSON.stringify(payload),JSON.stringify(change)]);
     }
   }
   // Retain provenance/mapping; source remains unchanged and available for export.
   target.run("INSERT INTO sync_association(source,mapping) VALUES(?,?)",[sourceKey,JSON.stringify({ids:Object.fromEntries(mapping),sourceRecords:Object.fromEntries(snapshots)})]);
   // Equivalent seed catalog rows may not have a queued operation after a previous pull.
   for(const type of ["exercise","exercise_name"] as const) for(const row of snapshots.get(type)!) {
     const id=String(mapped(type,row.id));
     if(!target.get("SELECT revision FROM sync_shadow WHERE record_type=? AND client_id=?",[type,id]) && !target.get("SELECT seq FROM sync_outbox WHERE record_type=? AND client_id=?",[type,id])) queue(target,type,id,localPayload(target,type,id));
   }
   target.run("UPDATE sync_state SET local_version=local_version+1 WHERE id=1");
 });
}
