import { router } from "expo-router";
import { useRef, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useDatabase, useWorkspace } from "../../../composition/database";
import { restoreBackup } from "../../../modules/backup";
import { documentFiles } from "../../../storage/files";
import { NavBar, PageHeading, Panel, Screen, SectionTitle, WarmNote, screenPadding } from "../../../ui/chrome";
import { PrimaryButton, SecondaryButton } from "../../../ui/fields";
import { formatExportedAt } from "../../../ui/format";
import { useRestoreDraft } from "../../../ui/restoreDraft";
import { useAppearance, usePalette } from "../../../ui/theme";

export default function RestoreScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const workspace = useWorkspace();
  const accountBacked = workspace.access.mode !== "anonymous";
  const appearance = useAppearance();
  const { draft, setDraft } = useRestoreDraft();
  const [message, setMessage] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const busy = useRef(false);

  function cancel() {
    setDraft(null);
    if (router.canGoBack()) router.back();
    else router.replace("/backup");
  }

  function confirm() {
    if (accountBacked) { setMessage("Account history cannot be replaced from a backup file. Your workouts were kept."); return; }
    if (!draft || busy.current || done) return;
    busy.current = true;
    const result = restoreBackup(db, documentFiles, draft.raw, new Date().toISOString(), workspace.workspaceId);
    if (!result.ok) {
      busy.current = false;
      setMessage(
        result.code === "WORKSPACE_MISMATCH"
          ? "This backup belongs to another workspace. Nothing was replaced."
          : "Restore did not finish. Your current workouts were kept.",
      );
      return;
    }
    appearance.reload();
    setDone(true);
    setDraft(null);
    setMessage("Restore finished. A safety backup of the previous workouts is on this phone.");
  }

  return (
    <Screen>
      <NavBar title="Review restore" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow="Check before replacing data." title="Review your backup" />
        {accountBacked ? <WarmNote title="Account history is protected" body="File replacement needs a separate merge. You can still export account history." /> : null}
        {draft ? (
          <Panel>
            <SectionTitle>Liftlog backup</SectionTitle>
            <Text style={{ color: palette.muted, marginTop: 7 }}>Exported {formatExportedAt(draft.preview.exportedAt)}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 28, marginTop: 18 }}>
              <Stat value={String(draft.preview.counts.workouts)} label="Workouts" />
              <Stat value={String(draft.preview.counts.workoutSets)} label="Sets" />
              <Stat value={String(draft.preview.counts.exercises)} label="Exercises" />
            </View>
          </Panel>
        ) : (
          <Text style={{ color: palette.muted, fontSize: 16 }}>{done ? "The backup has been restored." : "Choose a backup file before replacing workouts."}</Text>
        )}
        {draft && !done ? (
          <WarmNote title="This replaces your current workouts." body="A safety backup will be saved first. Only continue if this is the file you want to restore." />
        ) : null}
        {draft && !done && !accountBacked ? <PrimaryButton label="Replace workouts" onPress={confirm} /> : null}
        <SecondaryButton label={done ? "Done" : "Cancel"} onPress={cancel} />
        {message ? <Text style={{ color: done ? palette.primary : palette.warmInk, marginTop: 14 }}>{message}</Text> : null}
      </ScrollView>
    </Screen>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  const palette = usePalette();
  return (
    <View>
      <Text style={{ color: palette.text, fontSize: 23, fontWeight: "700", letterSpacing: -0.6, fontVariant: ["tabular-nums"] }}>{value}</Text>
      <Text style={{ color: palette.muted, fontSize: 12, marginTop: 2 }}>{label}</Text>
    </View>
  );
}
