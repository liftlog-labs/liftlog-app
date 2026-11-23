import { pilotOrigin } from "../shared/pilot";
import { appFetch } from "../shared/http";
import { isChatResponse, validChatRequest, validChatResponse } from "./chatBoundary";
import { authHeaders, assertCredentialDestination, normalizeServerUrl } from "./accountSession";
import { parsePounds } from "../shared/load";
import { normalizeName } from "../shared/names";
import { err, ok, type Result, type ErrorCode } from "../shared/result";
import type { SqlExecutor } from "../storage/sql";
import {
  addExerciseToWorkout,
  confirmSet,
  getOpenWorkout,
  getWorkout,
  searchExercises,
  startWorkout,
  deleteSet,
  type ExerciseType,
} from "./workout";

export type ChatExercise = { id: string; name: string; type: ExerciseType };

export type ChatProposal =
  | { kind: "start_workout"; label: string }
  | { kind: "resume_workout"; workoutId: string; label: string }
  | {
      kind: "log_set";
      workoutId: string;
      exerciseId: string;
      exerciseName: string;
      loadLb: string;
      reps: number;
      assisted: boolean;
    };

export type ChatResponse =
  | { version: 1; status: "proposal"; contextRevision: string; proposal: ChatProposal }
  | { version: 1; status: "clarify"; contextRevision: string; question: string; reason: string };

export type ChatRequest = {
  note: string;
  aiPolicyId?: string;
  consent: true;
  contextRevision: string;
  workout: { id: string; label: string; ended: false } | null;
  exercises: ChatExercise[];
};

const CONSENT_KEY = "chat_text_consent";
const URL_KEY = "course_base_url";

export function contextRevision(db: SqlExecutor): string {
  const open = getOpenWorkout(db);
  return open ? `${open.workoutId}:open` : "none";
}

export function hasChatConsent(db: SqlExecutor): boolean {
  return db.get<{ value: string }>("SELECT value FROM preference WHERE key = ?", [CONSENT_KEY])?.value === "granted";
}

export function grantChatConsent(db: SqlExecutor): void {
  db.run(
    `INSERT INTO preference (key, value) VALUES (?, 'granted')
     ON CONFLICT(key) DO UPDATE SET value = 'granted'`,
    [CONSENT_KEY],
  );
}

export function courseBaseUrl(db: SqlExecutor): string {
  return pilotOrigin ?? (db.get<{ value: string }>("SELECT value FROM preference WHERE key = ?", [URL_KEY])?.value || "http://127.0.0.1:8000");
}

export function setCourseBaseUrl(db: SqlExecutor, value: string): void {
  db.run(
    `INSERT INTO preference (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [URL_KEY, normalizeServerUrl(value.trim())],
  );
}

export function buildChatRequest(db: SqlExecutor, note: string): ChatRequest {
  const open = getOpenWorkout(db);
  return {
    note,
    consent: true,
    contextRevision: contextRevision(db),
    workout: open ? { id: open.workoutId, label: open.label, ended: false } : null,
    exercises: searchExercises(db, "").map((exercise) => ({
      id: exercise.exerciseId,
      name: exercise.name,
      type: exercise.type,
    })),
  };
}

export function applyChatResponse(
  db: SqlExecutor,
  input: {
    actionId: string;
    sentRevision: string;
    response: unknown;
    now: string;
    localDate: string;
  },
): Result<{ kind: "started" | "resumed" | "saved" | "clarify"; workoutId?: string; setId?: string; line?: string; question?: string }> {
  if (!isChatResponse(input.response) || input.response.contextRevision !== input.sentRevision) return err("INVALID_INPUT");
  if (input.response.status === "clarify") {
    return ok({ kind: "clarify", question: input.response.question });
  }
  const proposal = input.response.proposal;
  if (proposal.kind === "log_set") {
    const existing = db.get<{ id: string }>("SELECT id FROM workout_set WHERE id = ?", [input.actionId]);
    if (existing) return ok({ kind: "saved", workoutId: proposal.workoutId, setId: existing.id, line: setLine(proposal) });
  }
  if (proposal.kind === "start_workout") {
    const existingWorkout = getWorkout(db, input.actionId);
    if (existingWorkout) return ok({ kind: "started", workoutId: existingWorkout.workoutId });
  }
  if (contextRevision(db) !== input.sentRevision) return err("STALE");

  if (proposal.kind === "start_workout") {
    const label = titleLabel(proposal.label);
    if (!label) return err("INVALID_INPUT");
    const open = getOpenWorkout(db);
    if (open && normalizeName(open.label) === normalizeName(label)) {
      return ok({ kind: "resumed", workoutId: open.workoutId });
    }
    if (open) return err("LIVE_WORKOUT_EXISTS", { workoutId: open.workoutId });
    const started = startWorkout(db, { actionId: input.actionId, label, now: input.now, localDate: input.localDate });
    if (!started.ok) return started;
    return ok({ kind: "started", workoutId: started.value.workoutId });
  }

  if (proposal.kind === "resume_workout") {
    const open = getOpenWorkout(db);
    if (!open || open.workoutId !== proposal.workoutId) return err("STALE");
    return ok({ kind: "resumed", workoutId: open.workoutId });
  }

  const open = getOpenWorkout(db);
  if (!open || open.workoutId !== proposal.workoutId) return err("STALE");
  const known = searchExercises(db, "").find((exercise) => exercise.exerciseId === proposal.exerciseId);
  if (known && known.name !== proposal.exerciseName) return err("INVALID_INPUT");
  if (!known) return err("NOT_FOUND");
  if (parsePounds(proposal.loadLb) === null || !Number.isInteger(proposal.reps) || proposal.reps < 1) {
    return err("INVALID_INPUT");
  }
  if(known.type === "duration") return err("INVALID_INPUT");
  try {
    return db.transaction(() => {
      const entry = addExerciseToWorkout(db, {
        actionId: `${input.actionId}-entry`, workoutId: open.workoutId,
        exerciseId: proposal.exerciseId, now: input.now,
      });
      if (!entry.ok) throw new ChatWriteFailure(entry);
      const saved = confirmSet(db, {
        actionId: input.actionId, workoutId: open.workoutId, exerciseId: proposal.exerciseId,
        totalLb: proposal.loadLb, reps: proposal.reps, assisted: proposal.assisted, note: null, now: input.now,
      });
      if (!saved.ok) throw new ChatWriteFailure(saved);
      return ok({kind:"saved" as const,workoutId:open.workoutId,setId:saved.value.setId,line:setLine(proposal)});
    });
  } catch(error) { return error instanceof ChatWriteFailure ? error.failure : err("STORAGE_FAILURE"); }

}

export async function requestChat(input: {
  baseUrl: string;
  body: ChatRequest;
  authorization?: string | null;
  boundOrigin?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<Result<ChatResponse>> {
  let baseUrl:string;
  try {baseUrl=normalizeServerUrl(input.baseUrl);}catch{return err("INVALID_INPUT");}
  if(input.authorization){try{assertCredentialDestination(baseUrl,input.boundOrigin);}catch{return err("WORKSPACE_MISMATCH");}}
  if(!validChatRequest(input.body)) return err("INVALID_INPUT");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 20000);
  try {
    const response = await (input.fetchImpl ?? appFetch)(`${baseUrl}/api/v1/chat/interpret`, {
      method: "POST", redirect: "error", headers: authHeaders(input.authorization ?? null),
      body: JSON.stringify(input.body), signal: controller.signal,
    });
    if (response.status === 403) return err("CONSENT_REQUIRED");
    if (response.status === 400) return err("INVALID_INPUT");
    if (response.status === 401) return err("SIGN_IN");
    if (!response.ok || response.redirected) return err("SERVICE_ERROR");
    let body:unknown;
    try {body=await response.json();}catch{return err("SERVICE_ERROR");}
    if (!validChatResponse(body,input.body)) return err("SERVICE_ERROR");
    return ok(body);
  } catch {
    return err("NETWORK_ERROR");
  } finally { clearTimeout(timer); }
}

export function undoLoggedSet(db: SqlExecutor, setId: string, now: string): Result<{ setId: string }> {
  return deleteSet(db, setId, now);
}

function setLine(proposal: { loadLb: string; reps: number; exerciseName: string }): string {
  return `${proposal.exerciseName} ${proposal.loadLb} lb × ${proposal.reps}`;
}

function titleLabel(value: string): string {
  return value
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

class ChatWriteFailure extends Error { constructor(readonly failure: {ok:false;code:ErrorCode;fields?:Record<string,string>}) { super(failure.code); } }
