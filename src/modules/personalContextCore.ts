import type { Equipment, ExercisePreference, TrainingProfile } from "./trainingProfile";

export const RECENT_DAY_WINDOW = 28;
export const MAX_RECENT_SESSIONS = 8;
export const MAX_SETS_PER_SESSION = 12;
export const MAX_BASELINES = 8;
export const MAX_GAPS = 12;
export const MAX_GAP_CHARS = 160;
export const MAX_PREFERENCES = 12;

export type PerformedSet = {
  id: string;
  exerciseId: string;
  exerciseName: string;
  exerciseType: "barbell" | "dumbbell" | "machine" | "bodyweight" | "duration";
  workoutId: string;
  workoutLabel: string;
  date: string;
  loadLb: string | null;
  reps: number | null;
  assisted: boolean;
  ended: boolean;
  deleted?: boolean;
  loggedAt?: string | null;
};

export type PlannedSet = {
  id: string;
  exerciseId: string;
  loadLb: string | null;
  reps: number | null;
};

export type PersonalSnapshot = {
  asOf: string;
  timeZone: string;
  profile: TrainingProfile;
  performedSets: PerformedSet[];
  plannedSets: PlannedSet[];
  activeWorkout: { id: string; label: string; date: string } | null;
};

export type PersonalContext = {
  asOf: string;
  timeZone: string;
  localDate: string;
  window: { start: string; end: string; days: number };
  profileRevision: number;
  revision: string;
  profile: {
    goal: TrainingProfile["goal"];
    experience: TrainingProfile["experience"];
    trainingDays: number | null;
    sessionMinutes: number | null;
    equipment: Equipment[] | null;
    preferences: ExercisePreference[] | null;
  };
  activeWorkout: PersonalSnapshot["activeWorkout"];
  activePlan: null;
  recentSessions: {
    workoutId: string;
    label: string;
    date: string;
    setIds: string[];
    setOrder: "logged_at" | "unordered";
  }[];
  baselines: {
    exerciseId: string;
    exerciseName: string;
    exerciseType: PerformedSet["exerciseType"];
    setId: string;
    date: string;
    loadLb: string;
    reps: number;
  }[];
  performedVolumeLb: string;
  includedSetIds: string[];
  coverage: "included_sets_only";
  sessionChronology: "date_only";
  truncation: { truncated: boolean; reasons: string[] };
  gaps: string[];
};

export function buildPersonalContext(snapshot: PersonalSnapshot): PersonalContext {
  const localDate = localDateInTimeZone(snapshot.asOf, snapshot.timeZone);
  const start = addDays(localDate, -(RECENT_DAY_WINDOW - 1));
  const gaps: string[] = [];
  const profile = snapshot.profile;
  if (profile.goal === null) gaps.push("Goal is unknown.");
  if (profile.experience === null) gaps.push("Experience is unknown.");
  if (profile.trainingDays === null) gaps.push("Training days are unknown.");
  if (profile.sessionMinutes === null) gaps.push("Session duration is unknown.");
  if (profile.equipment === null) gaps.push("Equipment is unknown.");
  if (profile.preferences === null) gaps.push("Exercise preferences are unknown.");

  const future = snapshot.performedSets.filter((set) => set.date > localDate);
  if (future.length > 0) gaps.push(`Future-dated records excluded: ${ids(future)}.`);

  const qualifying = snapshot.performedSets.filter(
    (set) => !set.deleted && set.ended && set.date >= start && set.date <= localDate,
  );
  const ambiguous = qualifying.filter(isAmbiguousLoad);
  if (ambiguous.length > 0) gaps.push(`Load is ambiguous or missing and was excluded from totals: ${ids(ambiguous)}.`);
  const assisted = qualifying.filter((set) => set.assisted && !isAmbiguousLoad(set));
  if (assisted.length > 0) gaps.push(`Assisted sets are not used as baselines: ${ids(assisted)}.`);

  const countable = qualifying.filter((set) => !set.assisted && !isAmbiguousLoad(set) && countableLoad(set));
  const truncation: string[] = [];
  const sessions = buildSessions(qualifying, truncation);
  const includedSetIds = sessions.flatMap((session) => session.setIds);
  const included = new Set(includedSetIds);
  const countableIncluded = countable.filter((set) => included.has(set.id));
  const baselines = latestBaselines(countableIncluded, gaps, truncation);
  const preferences = boundPreferences(profile.preferences, truncation);
  const boundedGaps = boundGaps(gaps, truncation);

  if (sessions.length < 2) {
    boundedGaps.push("Completed history in this window is sparse. Missing logs do not show what happened on other days.");
  }

  const profileKey = [
    profile.goal ?? "",
    profile.experience ?? "",
    profile.trainingDays ?? "",
    profile.sessionMinutes ?? "",
    (profile.equipment ?? []).join("+"),
    (profile.preferences ?? []).map((item) => `${item.exerciseId}:${item.stance}`).sort().join(","),
  ].join("|");
  const activeKey = snapshot.activeWorkout
    ? `${snapshot.activeWorkout.id}|${snapshot.activeWorkout.label}|${snapshot.activeWorkout.date}`
    : "none";
  const valueKey = qualifying
    .filter((set) => included.has(set.id))
    .map(setFingerprint)
    .sort()
    .join(";");
  const revision = `${profile.revision}:${profileKey}:${activeKey}:${localDate}:${valueKey}`;

  return {
    asOf: snapshot.asOf,
    timeZone: snapshot.timeZone,
    localDate,
    window: { start, end: localDate, days: RECENT_DAY_WINDOW },
    profileRevision: profile.revision,
    revision,
    profile: {
      goal: profile.goal,
      experience: profile.experience,
      trainingDays: profile.trainingDays,
      sessionMinutes: profile.sessionMinutes,
      equipment: profile.equipment,
      preferences,
    },
    activeWorkout: snapshot.activeWorkout,
    activePlan: null,
    recentSessions: sessions,
    baselines,
    performedVolumeLb: volume(countableIncluded),
    includedSetIds,
    coverage: "included_sets_only",
    sessionChronology: "date_only",
    truncation: { truncated: truncation.length > 0, reasons: truncation },
    gaps: boundedGaps.slice(0, MAX_GAPS),
  };
}

function buildSessions(sets: PerformedSet[], truncation: string[]): PersonalContext["recentSessions"] {
  const byWorkout = new Map<string, PerformedSet[]>();
  for (const set of sets) {
    const group = byWorkout.get(set.workoutId) ?? [];
    group.push(set);
    byWorkout.set(set.workoutId, group);
  }
  const sessions = [...byWorkout.entries()]
    .map(([workoutId, group]) => {
      const ordered = orderSets(group);
      const kept = ordered.sets.slice(0, MAX_SETS_PER_SESSION);
      if (ordered.sets.length > kept.length) truncation.push(`Sets in workout ${workoutId} were limited to ${MAX_SETS_PER_SESSION}.`);
      return {
        workoutId,
        label: group[0]?.workoutLabel ?? "",
        date: group[0]?.date ?? "",
        setIds: kept.map((set) => set.id),
        setOrder: ordered.order,
      };
    })
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.workoutId.localeCompare(b.workoutId)));
  if (sessions.length > MAX_RECENT_SESSIONS) {
    truncation.push(`Recent sessions were limited to ${MAX_RECENT_SESSIONS}. Totals use only those sessions.`);
  }
  return sessions.slice(0, MAX_RECENT_SESSIONS);
}

function orderSets(sets: PerformedSet[]): { sets: PerformedSet[]; order: "logged_at" | "unordered" } {
  if (sets.length > 1 && sets.every((set) => set.loggedAt)) {
    return {
      order: "logged_at",
      sets: [...sets].sort((a, b) => String(a.loggedAt).localeCompare(String(b.loggedAt))),
    };
  }
  // Choose bounded membership deterministically, without pretending IDs are chronology.
  // Preserve the existing display/input order within that unordered membership.
  const chosen = new Set([...sets].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_SETS_PER_SESSION).map(set => set.id));
  return { order: "unordered", sets: [...sets.filter(set => chosen.has(set.id)), ...sets.filter(set => !chosen.has(set.id))] };
}

function latestBaselines(sets: PerformedSet[], gaps: string[], truncation: string[]): PersonalContext["baselines"] {
  const byExercise = new Map<string, PerformedSet[]>();
  for (const set of sets) {
    const group = byExercise.get(set.exerciseId) ?? [];
    group.push(set);
    byExercise.set(set.exerciseId, group);
  }
  const baselines: PersonalContext["baselines"] = [];
  for (const group of byExercise.values()) {
    const newestDate = group.reduce((latest, set) => (set.date > latest ? set.date : latest), "");
    const sameDay = group.filter((set) => set.date === newestDate);
    const chosen = chooseBaseline(sameDay);
    if (!chosen) {
      gaps.push(`No single baseline for ${group[0]?.exerciseName ?? "an exercise"} on ${newestDate}: timestamps are missing.`);
      continue;
    }
    if (chosen.reps === null || chosen.loadLb === null) continue;
    baselines.push({
      exerciseId: chosen.exerciseId,
      exerciseName: chosen.exerciseName,
      exerciseType: chosen.exerciseType,
      setId: chosen.id,
      date: chosen.date,
      loadLb: chosen.loadLb,
      reps: chosen.reps,
    });
  }
  baselines.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.exerciseId.localeCompare(b.exerciseId)));
  if (baselines.length > MAX_BASELINES) truncation.push(`Baselines were limited to ${MAX_BASELINES}.`);
  return baselines.slice(0, MAX_BASELINES);
}

function chooseBaseline(sets: PerformedSet[]): PerformedSet | null {
  if (sets.length === 1) return sets[0];
  if (sets.every((set) => set.loggedAt)) {
    return [...sets].sort((a, b) => String(a.loggedAt).localeCompare(String(b.loggedAt))).at(-1) ?? null;
  }
  return null;
}

function setFingerprint(set: PerformedSet): string {
  return [set.id, set.exerciseId, set.exerciseName, set.workoutId, set.workoutLabel, set.date, set.exerciseType, set.loadLb ?? "", set.reps ?? "", set.assisted ? "1" : "0", set.loggedAt ?? ""].join(":");
}

function boundPreferences(preferences: ExercisePreference[] | null, truncation: string[]): ExercisePreference[] | null {
  if (preferences === null) return null;
  if (preferences.length <= MAX_PREFERENCES) return preferences;
  truncation.push(`Exercise preferences were limited to ${MAX_PREFERENCES}.`);
  return preferences.slice(0, MAX_PREFERENCES);
}

function boundGaps(gaps: string[], truncation: string[]): string[] {
  return gaps.map((gap) => {
    if (gap.length <= MAX_GAP_CHARS) return gap;
    truncation.push("Gap text was shortened.");
    return `${gap.slice(0, MAX_GAP_CHARS - 1)}…`;
  });
}

function volume(sets: PerformedSet[]): string {
  let cents = 0;
  for (const set of sets) {
    if (set.loadLb === null || set.reps === null) continue;
    const [whole, frac = ""] = set.loadLb.split(".");
    const loadCents = Number(whole) * 100 + Number((frac + "00").slice(0, 2));
    cents += loadCents * set.reps;
  }
  const whole = Math.trunc(cents / 100);
  const frac = Math.abs(cents % 100);
  if (frac === 0) return String(whole);
  if (frac % 10 === 0) return `${whole}.${frac / 10}`;
  return `${whole}.${String(frac).padStart(2, "0")}`;
}

function countableLoad(set: PerformedSet): boolean {
  if (set.exerciseType === "bodyweight" || set.exerciseType === "duration") return false;
  return set.loadLb !== null && /^\d+(\.\d{1,2})?$/.test(set.loadLb) && set.reps !== null && Number.isInteger(set.reps) && set.reps > 0 && set.reps <= 1000 && set.loadLb.length <= 10 && Number(set.loadLb) <= 100000;
}

function isAmbiguousLoad(set: PerformedSet): boolean {
  if (set.exerciseType === "bodyweight" || set.exerciseType === "duration") return false;
  if (set.reps === null) return false;
  return !countableLoad(set);
}

function ids(sets: PerformedSet[]): string {
  return sets.map((set) => set.id).join(", ");
}

function localDateInTimeZone(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(iso));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

function addDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
