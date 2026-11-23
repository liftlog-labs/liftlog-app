import { router, useLocalSearchParams } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, Text, useWindowDimensions, View } from "react-native";
import { useDatabase } from "../../../../../composition/database";
import { confirmSet, deleteSet, getOpenWorkoutId, getWorkout, updateSet, type ExerciseType } from "../../../../../modules/workout";
import { createId } from "../../../../../shared/id";
import { Muted, NavBar, Notice, PageHeading, Screen, screenPadding } from "../../../../../ui/chrome";
import { FieldLabel, FilterChip, PrimaryButton, SecondaryButton, TextAction, TextField, ToggleRow } from "../../../../../ui/fields";
import { oneParam } from "../../../../../ui/format";
import { usePalette } from "../../../../../ui/theme";

export default function SetScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const params = useLocalSearchParams<{ id: string; exerciseId?: string; setId?: string }>();
  const workoutId = oneParam(params.id) ?? "";
  const exerciseId = oneParam(params.exerciseId);
  const setId = oneParam(params.setId);
  const workout = getWorkout(db, workoutId);
  const entry = workout?.entries.find((item) => item.exerciseId === exerciseId) ?? null;
  const existing = entry?.sets.find((item) => item.setId === setId);
  const setNumber = (entry?.sets.length ?? 0) + 1;
  const [mode, setMode] = useState<"total" | "plates">("total");
  const [totalLb, setTotalLb] = useState(existing?.loadLb ?? "");
  const [platesLb, setPlatesLb] = useState("");
  const [reps, setReps] = useState(existing?.reps ? String(existing.reps) : "");
  const [minutes, setMinutes] = useState(existing?.durationSec != null ? String(Math.floor(existing.durationSec / 60)) : "");
  const [seconds, setSeconds] = useState(existing?.durationSec != null ? String(existing.durationSec % 60) : "");
  const [assisted, setAssisted] = useState(existing?.assisted ?? false);
  const actionId = useRef<string | null>(null);
  const committed = useRef<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { width } = useWindowDimensions();
  const stacked = width < 360;

  if (!workout || !entry || (setId && !existing)) {
    return (
      <Screen>
        <NavBar title="Log a set" />
        <View style={{ padding: 22 }}>
          <Text style={{ color: palette.text, fontSize: 17 }}>That exercise is not in this workout.</Text>
        </View>
      </Screen>
    );
  }

  const type = entry.type;
  const entryExerciseId = entry.exerciseId;
  const bar = entry.barWeightLb ?? "45";

  function done() {
    if (router.canGoBack()) router.back();
    else router.replace(`/workout/${workoutId}`);
  }

  function save() {
    if (committed.current) return;
    if (!existing && getOpenWorkoutId(db) !== workoutId) {
      setMessage("This workout is no longer open.");
      return;
    }
    actionId.current ??= createId();
    const draft = {
      workoutId,
      exerciseId: entryExerciseId,
      totalLb: type === "barbell" && mode === "plates" ? undefined : totalLb,
      platesLb: type === "barbell" && mode === "plates" ? platesLb : undefined,
      reps: Number(reps),
      durationSec: Number(minutes || 0) * 60 + Number(seconds || 0),
      assisted,
      note: existing?.note ?? null,
      now: new Date().toISOString(),
    };
    let result: ReturnType<typeof confirmSet>;
    try {
      result = existing ? updateSet(db, { setId: existing.setId, ...draft }) : confirmSet(db, { actionId: actionId.current, ...draft });
    } catch {
      setMessage("Set not saved. Try again.");
      return;
    }
    if (!result.ok) {
      setMessage(result.fields ? Object.values(result.fields)[0] : "Set not saved. Try again.");
      return;
    }
    committed.current = result.value.setId;
    if (existing) {
      done();
      return;
    }
    setSaved(result.value.setId);
    setMessage(null);
  }

  function undo() {
    if (!saved || committed.current !== saved) return;
    const removed = deleteSet(db, saved, new Date().toISOString());
    if (!removed.ok) {
      setMessage("Set not undone. Try again.");
      return;
    }
    committed.current = null;
    actionId.current = null;
    setSaved(null);
    setMessage("Set undone.");
  }

  const receipt = entry.sets.find((set) => set.setId === saved);
  const previous = entry.lastComparableSet;
  function repeat() {
    if (!previous) return;
    const set = previous.set;
    setMode("total");
    setTotalLb(set.loadLb ?? "");
    setPlatesLb("");
    setReps(set.reps === null ? "" : String(set.reps));
    setMinutes(set.durationSec === null ? "" : String(Math.floor(set.durationSec / 60)));
    setSeconds(set.durationSec === null ? "" : String(set.durationSec % 60));
    setAssisted(set.assisted);
    setMessage(null);
  }

  function remove() {
    if (!existing) return;
    const removed = deleteSet(db, existing.setId, new Date().toISOString());
    if (!removed.ok) {
      setMessage("Set not deleted. Try again.");
      return;
    }
    done();
  }

  return (
    <Screen>
      <NavBar title={existing ? "Edit set" : "Log a set"} />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
        <PageHeading eyebrow={workout.label} title={entry.name} />
        {saved ? <>
          <Notice title="Set saved" body={receipt ? `${receipt.line}${receipt.assisted ? " · Assisted" : ""}` : "Your completed set was added to this workout."} />
          {message ? <Text style={{ color: palette.warmInk, marginTop: 12 }}>{message}</Text> : null}
          <PrimaryButton label="Done" onPress={done} />
          <SecondaryButton label="Undo set" onPress={undo} />
        </> : <>
        <Muted>Set {existing ? entry.sets.indexOf(existing) + 1 : setNumber}</Muted>
        {!existing && previous ? <>
          <Notice title="Last comparable set" body={`${previous.set.line}${previous.set.assisted ? " · Assisted" : ""} · ${previous.currentWorkout ? "This workout" : previous.date}`} />
          <TextAction label="Repeat previous set" onPress={repeat} />
        </> : !existing ? <Muted>No comparable sets yet.</Muted> : null}
        {type === "barbell" ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
            <FilterChip label="Total weight" selected={mode === "total"} onPress={() => setMode("total")} />
            <FilterChip label="Plates" selected={mode === "plates"} onPress={() => setMode("plates")} />
          </View>
        ) : null}
        <View style={{ flexDirection: stacked ? "column" : "row", gap: 13 }}>
          {type === "bodyweight" || type === "duration" ? null : (
            <WeightField type={type} mode={mode} totalLb={totalLb} platesLb={platesLb} onTotal={setTotalLb} onPlates={setPlatesLb} />
          )}
          {type === "duration" ? (
            <>
              <View style={{ flex: 1 }}>
                <FieldLabel>Minutes</FieldLabel>
                <TextField label="Minutes" value={minutes} onChangeText={setMinutes} keyboard="number-pad" />
              </View>
              <View style={{ flex: 1 }}>
                <FieldLabel>Seconds</FieldLabel>
                <TextField label="Seconds" value={seconds} onChangeText={setSeconds} keyboard="number-pad" />
              </View>
            </>
          ) : (
            <View style={{ flex: 1 }}>
              <FieldLabel>Reps</FieldLabel>
              <TextField label="Reps" value={reps} onChangeText={setReps} keyboard="number-pad" />
            </View>
          )}
        </View>
        <Muted size={12}>{helper(type, mode, bar)}</Muted>
        <ToggleRow label="Assisted set" value={assisted} onValueChange={setAssisted} />
        {message ? <Text style={{ color: palette.warmInk, marginTop: 12 }}>{message}</Text> : null}
        <PrimaryButton label={existing ? "Save changes" : "Save set"} onPress={save} />
        <SecondaryButton label="Cancel" onPress={done} />
        {existing ? <TextAction label="Delete set" onPress={remove} /> : null}
        </>}
      </ScrollView>
    </Screen>
  );
}

function WeightField({
  type,
  mode,
  totalLb,
  platesLb,
  onTotal,
  onPlates,
}: {
  type: ExerciseType;
  mode: "total" | "plates";
  totalLb: string;
  platesLb: string;
  onTotal: (value: string) => void;
  onPlates: (value: string) => void;
}) {
  if (type === "barbell" && mode === "plates") {
    return (
      <View style={{ flex: 1 }}>
        <FieldLabel>Plates · lb</FieldLabel>
        <TextField label="Plates in pounds" value={platesLb} onChangeText={onPlates} keyboard="decimal-pad" />
      </View>
    );
  }
  const label = type === "dumbbell" ? "Per hand · lb" : "Weight · lb";
  return (
    <View style={{ flex: 1 }}>
      <FieldLabel>{label}</FieldLabel>
      <TextField label={type === "dumbbell" ? "Weight per hand" : "Weight in pounds"} value={totalLb} onChangeText={onTotal} keyboard="decimal-pad" />
    </View>
  );
}

function helper(type: ExerciseType, mode: "total" | "plates", bar: string): string {
  if (type === "duration") return "Enter minutes and seconds.";
  if (type === "bodyweight") return "Enter the reps for this set.";
  if (type === "dumbbell") return "Enter the weight in one hand, in pounds.";
  if (type === "barbell" && mode === "plates") return `Plate weight is added to the ${bar} lb bar.`;
  if (type === "barbell") return "Enter the total weight, including the bar.";
  return "Enter the weight in pounds.";
}
