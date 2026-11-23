import type { SqlExecutor } from "../storage/sql";

export type ProgressPoint = { date: string; loadLb: string; reps: number };

export function progressSnapshot(db: SqlExecutor): {
  name: string | null;
  reps: number | null;
  points: ProgressPoint[];
  note: string | null;
} {
  const latest = db.get<{ exercise_id: string; display_name: string; reps: number; load_lb: string }>(
    `SELECT e.id AS exercise_id, n.display_name, s.reps AS reps, s.load_lb AS load_lb
     FROM workout_set s
     JOIN workout_exercise we ON we.id = s.workout_exercise_id AND we.deleted_at IS NULL
     JOIN workout w ON w.id = we.workout_id AND w.deleted_at IS NULL
     JOIN exercise e ON e.id = we.exercise_id
     JOIN exercise_name n ON n.exercise_id = e.id AND n.is_canonical = 1 AND n.deleted_at IS NULL
     WHERE s.deleted_at IS NULL AND s.reps IS NOT NULL AND s.load_lb IS NOT NULL
     ORDER BY w.date DESC, COALESCE(w.started_at, '') DESC, s.position DESC
     LIMIT 1`,
  );
  if (!latest) return { name: null, reps: null, points: [], note: null };
  const points = db.all<ProgressPoint>(
    `SELECT w.date AS date, s.load_lb AS loadLb, s.reps AS reps
     FROM workout_set s
     JOIN workout_exercise we ON we.id = s.workout_exercise_id AND we.deleted_at IS NULL
     JOIN workout w ON w.id = we.workout_id AND w.deleted_at IS NULL
     WHERE we.exercise_id = ? AND s.deleted_at IS NULL AND s.reps = ? AND s.load_lb IS NOT NULL
     ORDER BY w.date, COALESCE(w.started_at, ''), s.position`,
    [latest.exercise_id, latest.reps],
  );
  const first = Number(points[0]?.loadLb);
  const last = Number(points[points.length - 1]?.loadLb);
  const note =
    points.length >= 2 && Number.isFinite(first) && Number.isFinite(last) && last !== first
      ? `${formatDelta(last - first)} lb at the same reps.`
      : null;
  return { name: latest.display_name, reps: latest.reps, points, note };
}

function formatDelta(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return rounded > 0 ? `${rounded} more` : `${Math.abs(rounded)} less`;
}
