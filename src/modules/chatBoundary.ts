import type { ChatRequest, ChatResponse } from "./chat";

type ObjectValue = Record<string,unknown>;
function object(value:unknown):value is ObjectValue {return !!value && typeof value==='object' && !Array.isArray(value);}
function exact(value:ObjectValue,keys:string[]):boolean {return Object.keys(value).length===keys.length && keys.every(key=>Object.hasOwn(value,key));}
function text(value:unknown,max:number,min=1):value is string {return typeof value==='string' && value.length>=min && value.length<=max && (min===0 || !!value.trim());}
export function validChatRequest(value:unknown):value is ChatRequest {
 if(!object(value) || !exact(value,['note','consent','contextRevision','workout','exercises',...(value.aiPolicyId===undefined?[]:['aiPolicyId'])]) || !text(value.note,2000) || value.consent!==true || !text(value.contextRevision,256) || (value.aiPolicyId!==undefined && !text(value.aiPolicyId,128))) return false;
 if(value.workout!==null && (!object(value.workout) || !exact(value.workout,['id','label','ended']) || !text(value.workout.id,128) || !text(value.workout.label,80,0) || value.workout.ended!==false)) return false;
 if(!Array.isArray(value.exercises) || value.exercises.length>500) return false;
 const ids=new Set<string>();
 for(const exercise of value.exercises) {
  if(!object(exercise) || !exact(exercise,['id','name','type']) || !text(exercise.id,128) || !text(exercise.name,120) || typeof exercise.type!=='string' || !['barbell','dumbbell','machine','bodyweight','duration'].includes(exercise.type) || ids.has(exercise.id)) return false;
  ids.add(exercise.id);
 }
 return true;
}
export function isChatResponse(value:unknown):value is ChatResponse {
 if(!object(value) || value.version!==1 || !text(value.contextRevision,256)) return false;
 const keys=value.status==='clarify'?['version','status','contextRevision','question','reason']:['version','status','contextRevision','proposal'];
 // Server-owned diagnostic provider name is optional; never an action or ownership selector.
 if(value.provider!==undefined) {if(!text(value.provider,120)) return false;keys.push('provider');}
 if(!exact(value,keys)) return false;
 if(value.status==='clarify') return text(value.question,500) && typeof value.reason==='string' && ['workout','exercise','reps','intent'].includes(value.reason);
 if(value.status!=='proposal' || !object(value.proposal)) return false;
 const p=value.proposal;
 if(p.kind==='start_workout') return exact(p,['kind','label']) && text(p.label,80);
 if(p.kind==='resume_workout') return exact(p,['kind','workoutId','label']) && text(p.workoutId,128) && text(p.label,80);
 if(p.kind!=='log_set' || !exact(p,['kind','workoutId','exerciseId','exerciseName','loadLb','reps','assisted'])) return false;
 return text(p.workoutId,128) && text(p.exerciseId,128) && text(p.exerciseName,120) && typeof p.loadLb==='string' && /^\d{1,6}(?:\.\d{1,2})?$/.test(p.loadLb) && Number(p.loadLb)>0 && Number(p.loadLb)<=100000 && typeof p.reps==='number' && Number.isInteger(p.reps) && p.reps>=1 && p.reps<=1000 && typeof p.assisted==='boolean';
}
export function validChatResponse(value:unknown,request:ChatRequest):value is ChatResponse {
 if(!isChatResponse(value) || value.contextRevision!==request.contextRevision) return false;
 if(value.status==='clarify') return true;
 const p=value.proposal;
 if(p.kind==='start_workout') return request.workout===null;
 if(!request.workout || p.workoutId!==request.workout.id) return false;
 if(p.kind==='resume_workout') return p.label===request.workout.label;
 return request.exercises.some(e=>e.id===p.exerciseId && e.name===p.exerciseName);
}
