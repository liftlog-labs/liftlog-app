import { err, ok, type Result } from "../shared/result";
import type { SqlExecutor } from "../storage/sql";

export const GOALS = ["hypertrophy", "strength", "general_fitness"] as const;
export const EXPERIENCE_LEVELS = ["beginner", "intermediate", "experienced"] as const;
export const EQUIPMENT = ["barbell", "dumbbell", "machine", "cable", "bodyweight"] as const;

export type Goal = (typeof GOALS)[number];
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];
export type Equipment = (typeof EQUIPMENT)[number];
export type ExerciseStance = "prefer" | "avoid";

export type ExercisePreference = { exerciseId: string; stance: ExerciseStance };

export type TrainingProfile = {
  goal: Goal | null;
  experience: ExperienceLevel | null;
  trainingDays: number | null;
  sessionMinutes: number | null;
  equipment: Equipment[] | null;
  preferences: ExercisePreference[] | null;
  updatedAt: string | null;
  revision: number;
};

export const EMPTY_PROFILE: TrainingProfile = {
  goal: null,
  experience: null,
  trainingDays: null,
  sessionMinutes: null,
  equipment: null,
  preferences: null,
  updatedAt: null,
  revision: 0,
};

type ProfileRow = {
  goal: string | null;
  experience: string | null;
  training_days: number | null;
  session_minutes: number | null;
  equipment_json: string | null;
  preferences_json: string | null;
  updated_at: string;
  revision: number;
};

export function readTrainingProfile(db: SqlExecutor): TrainingProfile {
  const row = db.get<ProfileRow>("SELECT * FROM training_profile WHERE id = 'local'");
  if (!row) return EMPTY_PROFILE;
  return {
    goal: isGoal(row.goal) ? row.goal : null,
    experience: isExperience(row.experience) ? row.experience : null,
    trainingDays: row.training_days,
    sessionMinutes: row.session_minutes,
    equipment: parseEquipment(row.equipment_json),
    preferences: parsePreferences(row.preferences_json),
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

export function saveTrainingProfile(
  db: SqlExecutor,
  draft: Omit<TrainingProfile, "updatedAt" | "revision">,
  now: string,
): Result<TrainingProfile> {
  if (draft.goal !== null && !isGoal(draft.goal)) return err("INVALID_INPUT", { goal: "Unknown goal" });
  if (draft.experience !== null && !isExperience(draft.experience)) return err("INVALID_INPUT", { experience: "Unknown experience" });
  if (draft.trainingDays !== null && (!Number.isInteger(draft.trainingDays) || draft.trainingDays < 1 || draft.trainingDays > 7)) {
    return err("INVALID_INPUT", { trainingDays: "Training days must stay blank or be 1 to 7" });
  }
  if (draft.sessionMinutes !== null && (!Number.isInteger(draft.sessionMinutes) || draft.sessionMinutes < 15 || draft.sessionMinutes > 180)) {
    return err("INVALID_INPUT", { sessionMinutes: "Session length must stay blank or be 15 to 180 minutes" });
  }
  if (draft.equipment !== null && draft.equipment.some((item) => !isEquipment(item))) {
    return err("INVALID_INPUT", { equipment: "Unknown equipment" });
  }
  if (draft.preferences !== null && draft.preferences.some((item) => item.stance !== "prefer" && item.stance !== "avoid")) {
    return err("INVALID_INPUT", { preferences: "Unknown preference" });
  }
  const current = readTrainingProfile(db);
  const next: TrainingProfile = { ...draft, updatedAt: now, revision: current.revision + 1 };
  db.run(
    `INSERT INTO training_profile
      (id, goal, experience, training_days, session_minutes, equipment_json, preferences_json, updated_at, revision)
     VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      goal = excluded.goal,
      experience = excluded.experience,
      training_days = excluded.training_days,
      session_minutes = excluded.session_minutes,
      equipment_json = excluded.equipment_json,
      preferences_json = excluded.preferences_json,
      updated_at = excluded.updated_at,
      revision = excluded.revision`,
    [
      next.goal,
      next.experience,
      next.trainingDays,
      next.sessionMinutes,
      next.equipment === null ? null : JSON.stringify(next.equipment),
      next.preferences === null ? null : JSON.stringify(next.preferences),
      now,
      next.revision,
    ],
  );
  return ok(next);
}

function isGoal(value: string | null): value is Goal {
  return GOALS.includes(value as Goal);
}

function isExperience(value: string | null): value is ExperienceLevel {
  return EXPERIENCE_LEVELS.includes(value as ExperienceLevel);
}

function isEquipment(value: string): value is Equipment {
  return EQUIPMENT.includes(value as Equipment);
}

function parseEquipment(value: string | null): Equipment[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return null;
  return parsed.filter(isEquipment);
}

function parsePreferences(value: string | null): ExercisePreference[] | null {
  if (value === null) return null;
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) return null;
  return parsed.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as { exerciseId?: unknown; stance?: unknown };
    if (typeof row.exerciseId !== "string" || (row.stance !== "prefer" && row.stance !== "avoid")) return [];
    return [{ exerciseId: row.exerciseId, stance: row.stance }];
  });
}
