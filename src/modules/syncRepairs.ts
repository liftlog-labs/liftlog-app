import { normalizeName } from "../shared/names";
import type { SqlExecutor } from "../storage/sql";
import { listSyncConflicts, resolveSyncConflict } from "./syncStore";

// These actions are explicit user decisions; ordinary pulls never repair domain data silently.
export function repairSyncConflict(db:SqlExecutor,id:number,action:"finish"|"rename"|"separate",value?:string,now=new Date().toISOString()):void {
 const conflict=listSyncConflicts(db).find(c=>c.id===id);if(!conflict || conflict.reason!=="local_constraint") throw Error("Conflict no longer current");
 db.transaction(()=>{
   if(action==="finish" && conflict.recordType==="workout") {
     db.run("UPDATE workout SET ended_at=?,updated_at=? WHERE deleted_at IS NULL AND started_at IS NOT NULL AND ended_at IS NULL AND id<>?",[now,now,conflict.clientId]);
     resolveSyncConflict(db,id,"server",now);
   } else if(action==="rename" && conflict.recordType==="exercise_name") {
     const name=value?.trim();if(!name) throw Error("Enter a different exercise name");
     const original=String(conflict.remote.payload?.name??"");
     const existing=db.get<{id:string}>("SELECT id FROM exercise_name WHERE normalized_name=? AND deleted_at IS NULL AND id<>?",[normalizeName(original),conflict.clientId]);
     if(!existing) {resolveSyncConflict(db,id,"server",now);return;}
     db.run("UPDATE exercise_name SET display_name=?,normalized_name=?,updated_at=? WHERE id=?",[name,normalizeName(name),now,existing.id]);
     resolveSyncConflict(db,id,"server",now);
   } else if(action==="separate" && conflict.recordType==="workout_exercise") {
     const payload=conflict.remote.payload; if(!payload) throw Error("Entry unavailable");
     const existing=db.get<{id:string}>("SELECT id FROM workout_exercise WHERE workout_id=? AND exercise_id=? AND deleted_at IS NULL AND id<>?",[payload.workoutId,payload.exerciseId,conflict.clientId]);
     if(!existing) {resolveSyncConflict(db,id,"server",now);return;}
     const workout=db.get<{date:string;label:string|null}>("SELECT date,label FROM workout WHERE id=?",[payload.workoutId]);if(!workout) throw Error("Workout unavailable");
     const newId=db.get<{id:string}>("SELECT lower(hex(randomblob(16))) id")!.id;
     const label=`${workout.label??"Workout"} (phone copy)`;
     db.run("INSERT INTO workout(id,date,label,normalized_label,started_at,ended_at,created_at,updated_at) VALUES(?,?,?,?,NULL,NULL,?,?)",[newId,workout.date,label,normalizeName(label),now,now]);
     db.run("UPDATE workout_exercise SET workout_id=?,updated_at=? WHERE id=?",[newId,now,existing.id]);
     resolveSyncConflict(db,id,"server",now);
   } else throw Error("This action does not match the conflict");
 });
}
