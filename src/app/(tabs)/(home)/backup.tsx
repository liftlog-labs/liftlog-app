import * as DocumentPicker from "expo-document-picker";
import * as Sharing from "expo-sharing";
import { router } from "expo-router";
import { useState } from "react";
import { ScrollView, Text } from "react-native";
import { useDatabase, useWorkspace } from "../../../composition/database";
import { exportBackup, inspectBackup } from "../../../modules/backup";
import { documentFileUri, readUri, writeCacheFile } from "../../../storage/files";
import { Muted, NavBar, PageHeading, Panel, Screen, SectionTitle, Tile, screenPadding } from "../../../ui/chrome";
import { PrimaryButton, SecondaryButton, TextAction } from "../../../ui/fields";
import { useRestoreDraft } from "../../../ui/restoreDraft";
import { usePalette } from "../../../ui/theme";

export default function BackupScreen() {
  const palette = usePalette();
  const db = useDatabase();
  const workspace = useWorkspace();
  const accountBacked = workspace.access.mode !== "anonymous";
  const { setDraft } = useRestoreDraft();
  const [message, setMessage] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "bad">("ok");

  async function shareExport() {
    setMessage(null);
    const uri = writeCacheFile(`liftlog-backup-${Date.now()}.json`, JSON.stringify(exportBackup(db, new Date().toISOString(), workspace.workspaceId)));
    if (!(await Sharing.isAvailableAsync())) {
      setTone("bad");
      setMessage("Sharing is not available on this device.");
      return;
    }
    await Sharing.shareAsync(uri, { mimeType: "application/json", UTI: "public.json" });
    setTone("ok");
    setMessage("Backup exported.");
  }

  async function pickRestore() {
    setMessage(null);
    if (accountBacked) { setTone("bad"); setMessage("File replacement is unavailable for account history. Export a backup or switch to the local-only log to restore a file."); return; }
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, type: "application/json" });
    if (picked.canceled || !picked.assets[0]) return;
    const raw = readUri(picked.assets[0].uri);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setTone("bad");
      setMessage("That file is not valid JSON. Nothing was changed.");
      return;
    }
    const inspected = inspectBackup(parsed);
    if (!inspected.ok) {
      setTone("bad");
      setMessage("That backup was rejected. Nothing was changed.");
      setDraft(null);
      return;
    }
    if (inspected.value.workspace && inspected.value.workspace !== workspace.workspaceId) {
      setTone("bad");
      setMessage("This backup belongs to another workspace. Nothing was changed.");
      setDraft(null);
      return;
    }
    setDraft({ raw, preview: inspected.value });
    router.push("/restore");
  }

  async function shareSafety() {
    const uri = documentFileUri("liftlog-safety-backup.json");
    if (!uri || !(await Sharing.isAvailableAsync())) {
      setTone("bad");
      setMessage("No safety backup to share yet.");
      return;
    }
    await Sharing.shareAsync(uri, { mimeType: "application/json", UTI: "public.json" });
  }

  return (
    <Screen>
      <NavBar title="Backup & restore" />
      <ScrollView style={{ flex: 1 }} contentContainerStyle={screenPadding}>
        <PageHeading eyebrow="Keep a copy of your progress." title="Backup & restore" />
        <Panel>
          <Tile icon="download" background={palette.soft} />
          <SectionTitle>Export a backup</SectionTitle>
          <Text style={{ color: palette.muted, marginTop: 7 }}>Save a complete copy of your workouts and exercises to a file.</Text>
          <PrimaryButton label="Export backup" onPress={shareExport} />
        </Panel>
        <Panel>
          <Tile icon="upload" background={palette.soft} />
          <SectionTitle>Restore from a file</SectionTitle>
          <Text style={{ color: palette.muted, marginTop: 7 }}>{accountBacked ? "Account history cannot be replaced from a file. A safe merge is required; exports are still available." : "Choose a Liftlog backup. You’ll review it before anything changes."}</Text>
          {!accountBacked ? <SecondaryButton label="Choose backup file" onPress={pickRestore} /> : null}
        </Panel>
        <TextAction label="Share safety backup" onPress={shareSafety} />
        <Muted size={12}>Backups are files you manage. This is not automatic cloud sync.</Muted>
        {message ? <Text style={{ color: tone === "ok" ? palette.primary : palette.warmInk, marginTop: 14 }}>{message}</Text> : null}
      </ScrollView>
    </Screen>
  );
}
