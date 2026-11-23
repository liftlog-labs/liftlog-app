import { appFetch } from "../shared/http";
import type { Result } from "../shared/result";
import { err, ok } from "../shared/result";
import { authHeaders, assertCredentialDestination, normalizeServerUrl } from "./accountSession";
import type { SqlExecutor } from "../storage/sql";
import type { ExerciseType } from "./workout";

export type TrendRequest = {
  range: { start: string; end: string };
  workouts: {
    id: string;
    date: string;
    exercises: {
      exerciseId: string;
      name: string;
      type: ExerciseType;
      sets: {
        loadLb: string | null;
        reps: number | null;
        assisted: boolean;
        durationSec: number | null;
      }[];
    }[];
  }[];
};

export type TrendResult = {
  version: 1;
  range: { start: string; end: string };
  workoutCount: number;
  exercises: {
    exerciseId: string;
    name: string;
    sessionCount: number;
    totalVolumeLb: string | null;
    averageVolumeLb: string | null;
    frequencyPerWeek: string;
  }[];
};

export function buildTrendRequest(db: SqlExecutor, start: string, end: string): TrendRequest {
  const workouts = db.all<{ id: string; date: string }>(
    `SELECT id, date FROM workout
     WHERE deleted_at IS NULL AND date >= ? AND date <= ?
     ORDER BY date, id`,
    [start, end],
  );
  return {
    range: { start, end },
    workouts: workouts.map((workout) => {
      const exercises = db.all<{
        exercise_id: string;
        display_name: string;
        type: ExerciseType;
        load_lb: string | null;
        reps: number | null;
        assisted: number | null;
        duration_sec: number | null;
        set_id: string | null;
      }>(
        `SELECT e.id AS exercise_id, n.display_name, e.type, s.load_lb, s.reps, s.assisted, s.duration_sec, s.id AS set_id
         FROM workout_exercise we
         JOIN exercise e ON e.id = we.exercise_id
         JOIN exercise_name n ON n.exercise_id = e.id AND n.is_canonical = 1 AND n.deleted_at IS NULL
         LEFT JOIN workout_set s ON s.workout_exercise_id = we.id AND s.deleted_at IS NULL
         WHERE we.workout_id = ? AND we.deleted_at IS NULL
         ORDER BY we.position, s.position, s.id`,
        [workout.id],
      );
      const grouped = new Map<string, TrendRequest["workouts"][number]["exercises"][number]>();
      for (const row of exercises) {
        let exercise = grouped.get(row.exercise_id);
        if (!exercise) {
          exercise = { exerciseId: row.exercise_id, name: row.display_name, type: row.type, sets: [] };
          grouped.set(row.exercise_id, exercise);
        }
        if (row.set_id) {
          exercise.sets.push({
            loadLb: row.load_lb,
            reps: row.reps,
            assisted: row.assisted === 1,
            durationSec: row.duration_sec,
          });
        }
      }
      return { id: workout.id, date: workout.date, exercises: [...grouped.values()] };
    }),
  };
}

export async function requestTrends(input: {
  baseUrl: string;
  body: TrendRequest;
  authorization?: string | null;
  boundOrigin?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<Result<TrendResult>> {
  const fetchImpl = input.fetchImpl ?? appFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 8000);
  try {
    const baseUrl=normalizeServerUrl(input.baseUrl);
    if(input.authorization) assertCredentialDestination(baseUrl,input.boundOrigin);
    const response = await fetchImpl(`${baseUrl}/api/v1/analytics/trends`, {
      method: "POST",
      redirect: "error",
      headers: authHeaders(input.authorization ?? null),
      body: JSON.stringify(input.body),
      signal: controller.signal,
    });
    if (response.status === 401) return err("SIGN_IN");
    if (response.status >= 500 || response.status === 0) return err("UNAVAILABLE");
    if (!response.ok) return err("INVALID_INPUT");
    return ok((await response.json()) as TrendResult);
  } catch {
    return err("UNAVAILABLE");
  } finally {
    clearTimeout(timer);
  }
}
