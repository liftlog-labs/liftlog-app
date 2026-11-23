import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useDatabase, useWorkspace } from "../../../composition/database";
import { searchExercises } from "../../../modules/workout";
import {
  EQUIPMENT,
  EXPERIENCE_LEVELS,
  GOALS,
  readTrainingProfile,
  saveTrainingProfile,
  type Equipment,
  type ExercisePreference,
  type ExperienceLevel,
  type Goal,
  type TrainingProfile,
} from "../../../modules/trainingProfile";
import { Muted, NavBar, PageHeading, Screen, SectionTitle, screenPadding } from "../../../ui/chrome";
import { FilterChip } from "../../../ui/fields";
import { RestorationStatus } from "../../../ui/syncStatus";
import { usePalette } from "../../../ui/theme";

const GOAL_LABELS: Record<Goal, string> = {
  hypertrophy: "Hypertrophy",
  strength: "Strength",
  general_fitness: "General fitness",
};

const EXPERIENCE_LABELS: Record<ExperienceLevel, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  experienced: "Experienced",
};

export default function ProfileScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const { dataVersion } = useWorkspace();
  void dataVersion;
  const draft = readTrainingProfile(db);
  const [message, setMessage] = useState<string | null>(null);
  const exercises = searchExercises(db, "");

  function save(next: Omit<TrainingProfile, "updatedAt" | "revision">) {
    const result = saveTrainingProfile(db, next, new Date().toISOString());
    if (!result.ok) {
      setMessage("Profile not saved. Try again.");
      return;
    }
    setMessage("Saved");
  }

  function update(patch: Partial<Omit<TrainingProfile, "updatedAt" | "revision">>) {
    const { updatedAt: _updated, revision: _revision, ...rest } = draft;
    save({ ...rest, ...patch });
  }

  return (
    <Screen>
      <NavBar title="Training profile" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow="Only what you choose to save." title="Training profile" />
        <RestorationStatus />
        <Muted>Blank answers stay unknown. They are not treated as zero or as rest.</Muted>
        <SectionTitle>Primary goal</SectionTitle>
        <Choices>
          <FilterChip label="Not set" selected={draft.goal === null} onPress={() => update({ goal: null })} />
          {GOALS.map((goal) => (
            <FilterChip key={goal} label={GOAL_LABELS[goal]} selected={draft.goal === goal} onPress={() => update({ goal })} />
          ))}
        </Choices>
        <SectionTitle>Experience</SectionTitle>
        <Choices>
          <FilterChip label="Not set" selected={draft.experience === null} onPress={() => update({ experience: null })} />
          {EXPERIENCE_LEVELS.map((level) => (
            <FilterChip key={level} label={EXPERIENCE_LABELS[level]} selected={draft.experience === level} onPress={() => update({ experience: level })} />
          ))}
        </Choices>
        <SectionTitle>Training days each week</SectionTitle>
        <Choices>
          <FilterChip label="Not set" selected={draft.trainingDays === null} onPress={() => update({ trainingDays: null })} />
          {[2, 3, 4, 5, 6].map((days) => (
            <FilterChip key={days} label={String(days)} selected={draft.trainingDays === days} onPress={() => update({ trainingDays: days })} />
          ))}
        </Choices>
        <SectionTitle>Session length</SectionTitle>
        <Choices>
          <FilterChip label="Not set" selected={draft.sessionMinutes === null} onPress={() => update({ sessionMinutes: null })} />
          {[30, 45, 60, 90].map((minutes) => (
            <FilterChip key={minutes} label={`${minutes} min`} selected={draft.sessionMinutes === minutes} onPress={() => update({ sessionMinutes: minutes })} />
          ))}
        </Choices>
        <SectionTitle>Equipment</SectionTitle>
        <Muted>Not set means unknown, not that you have no equipment.</Muted>
        <Choices>
          <FilterChip label="Not set" selected={draft.equipment === null} onPress={() => update({ equipment: null })} />
          {EQUIPMENT.map((item) => (
            <FilterChip key={item} label={item} selected={draft.equipment?.includes(item) ?? false} onPress={() => update({ equipment: toggleEquipment(draft.equipment, item) })} />
          ))}
        </Choices>
        <SectionTitle>Exercise preferences</SectionTitle>
        {exercises.map((exercise) => {
          const stance = draft.preferences?.find((item) => item.exerciseId === exercise.exerciseId)?.stance ?? null;
          return (
            <View key={exercise.exerciseId} style={{ marginTop: 14, gap: 8 }}>
              <Text style={{ color: palette.text, fontSize: 15, fontWeight: "600" }}>{exercise.name}</Text>
              <Choices>
                <FilterChip label="No preference" selected={stance === null} onPress={() => update({ preferences: setStance(draft.preferences, exercise.exerciseId, null) })} />
                <FilterChip label="Prefer" selected={stance === "prefer"} onPress={() => update({ preferences: setStance(draft.preferences, exercise.exerciseId, "prefer") })} />
                <FilterChip label="Avoid" selected={stance === "avoid"} onPress={() => update({ preferences: setStance(draft.preferences, exercise.exerciseId, "avoid") })} />
              </Choices>
            </View>
          );
        })}
        {message ? (
          <Text style={{ color: message === "Saved" ? palette.primary : palette.warmInk, marginTop: 16 }}>{message}</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

function Choices({ children }: { children: React.ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 12 }}>{children}</View>;
}

function toggleEquipment(current: Equipment[] | null, item: Equipment): Equipment[] {
  const list = current ?? [];
  return list.includes(item) ? list.filter((entry) => entry !== item) : [...list, item];
}

function setStance(current: ExercisePreference[] | null, exerciseId: string, stance: "prefer" | "avoid" | null): ExercisePreference[] | null {
  const rest = (current ?? []).filter((item) => item.exerciseId !== exerciseId);
  if (stance === null) return rest.length === 0 ? null : rest;
  return [...rest, { exerciseId, stance }];
}
