import { router, useLocalSearchParams } from "expo-router";
import { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useDatabase, useWorkspace } from "../../../../../composition/database";
import { addExerciseToWorkout, browseExercises, createExercise, exerciseGroups, getOpenWorkoutId, type ExerciseGroup, type ExerciseType } from "../../../../../modules/workout";
import { createId } from "../../../../../shared/id";
import { NavBar, PageHeading, Screen, SectionTitle, screenPadding } from "../../../../../ui/chrome";
import { FieldLabel, FilterChip, PrimaryButton, TextField } from "../../../../../ui/fields";
import { exerciseTypeLabel, oneParam } from "../../../../../ui/format";
import { Icon } from "../../../../../ui/icons";
import { usePalette } from "../../../../../ui/theme";

const TYPES: { id: ExerciseType; label: string }[] = [
  { id: "barbell", label: "Barbell" },
  { id: "dumbbell", label: "Dumbbell" },
  { id: "machine", label: "Machine" },
  { id: "bodyweight", label: "Bodyweight" },
  { id: "duration", label: "Timed" },
];

export default function ExerciseScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const workoutId = oneParam(useLocalSearchParams<{ id: string }>().id) ?? "";
  const { dataVersion } = useWorkspace();
  const workoutOpen = getOpenWorkoutId(db) === workoutId;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<ExerciseGroup>("All");
  const [name, setName] = useState("");
  const [type, setType] = useState<ExerciseType>("barbell");
  const [message, setMessage] = useState<string | null>(null);
  const matches = useMemo(() => {
    void dataVersion;
    return browseExercises(db, query, group);
  }, [db, dataVersion, query, group]);

  function add(exerciseId: string) {
    if (getOpenWorkoutId(db) !== workoutId) {
      setMessage("This workout is no longer open.");
      return;
    }
    const added = addExerciseToWorkout(db, { actionId: createId(), workoutId: workoutId, exerciseId, now: new Date().toISOString() });
    if (!added.ok) {
      setMessage("Exercise not added. Try again.");
      return;
    }
    if (router.canGoBack()) router.back();
    else router.replace(`/workout/${workoutId}`);
  }

  function create() {
    if (getOpenWorkoutId(db) !== workoutId) return;
    const created = createExercise(db, { actionId: createId(), name, type, now: new Date().toISOString() });
    if (!created.ok) {
      setMessage(created.code === "NAME_TAKEN" ? "That exercise name is already used." : created.fields?.name ?? "Exercise not created. Try again.");
      return;
    }
    add(created.value.exerciseId);
  }

  return (
    <Screen>
      <NavBar title="Add exercise" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <PageHeading eyebrow="Build your session" title="Choose an exercise" />
        {!workoutOpen ? <Text style={{ color: palette.text }}>This workout is no longer open.</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 13, minHeight: 50, borderWidth: 1, borderColor: palette.line, borderRadius: 13, backgroundColor: palette.surface }}>
          <Icon name="search" color={palette.muted} />
          <TextInput
            accessibilityLabel="Search exercises"
            placeholder="Search names or aliases"
            placeholderTextColor={palette.muted}
            value={query}
            onChangeText={setQuery}
            autoCorrect={false}
            style={{ flex: 1, minHeight: 44, color: palette.text, fontSize: 16 }}
          />
        </View>
        <FieldLabel>Muscle group</FieldLabel>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {exerciseGroups.map((item) => (
            <FilterChip key={item} label={item} selected={group === item} onPress={() => setGroup(item)} />
          ))}
        </View>
        {message ? <Text style={{ color: palette.warmInk, marginTop: 12 }}>{message}</Text> : null}
        <Text style={{ color: palette.muted, fontSize: 12, marginTop: 18, marginBottom: 3 }}>{query.trim() ? "Matching exercises" : "Exercises"}</Text>
        {matches.length === 0 ? <Text style={{ color: palette.muted, marginTop: 8 }}>No exercises match that search.</Text> : null}
        {matches.map((exercise) => (
          <Pressable
            key={exercise.exerciseId}
            accessibilityRole="button"
            accessibilityLabel={`Add ${exercise.name}`}
            disabled={!workoutOpen}
            accessibilityState={{ disabled: !workoutOpen }}
            onPress={() => add(exercise.exerciseId)}
            style={({ pressed }) => ({
              minHeight: 44,
              paddingVertical: 17,
              borderBottomWidth: 1,
              borderBottomColor: palette.line,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <View style={{ flex: 1 }}>
              <Text style={{ color: palette.text, fontSize: 15, fontWeight: "600" }}>{exercise.name}</Text>
              <Text style={{ color: palette.muted, fontSize: 13, marginTop: 5 }}>{[exerciseTypeLabel(exercise.type), exercise.muscle, exercise.matchedAlias].filter(Boolean).join(" · ")}</Text>
            </View>
            <Icon name="plus" color={palette.primary} />
          </Pressable>
        ))}
        <View style={{ height: 1, backgroundColor: palette.line, marginVertical: 20 }} />
        <SectionTitle>Create an exercise</SectionTitle>
        <FieldLabel>Exercise name</FieldLabel>
        <TextField label="Exercise name" value={name} onChangeText={setName} placeholder="e.g. Front squat" />
        <FieldLabel>Exercise type</FieldLabel>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {TYPES.map((choice) => (
            <FilterChip key={choice.id} label={choice.label} selected={type === choice.id} onPress={() => setType(choice.id)} />
          ))}
        </View>
        <PrimaryButton label="Create exercise" onPress={create} disabled={!workoutOpen} />
      </ScrollView>
    </Screen>
  );
}
