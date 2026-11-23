import { router } from "expo-router";
import { Pressable, Text } from "react-native";
import { useWorkspace } from "../composition/database";
import { usePalette } from "./theme";

export function RestorationStatus() {
  const { sync } = useWorkspace();
  const palette = usePalette();
  if (!sync || sync.restored) return null;
  const needsVerification = sync.lastCode === "SERVER_CHANGED" || sync.lastCode === "ACCOUNT_MISMATCH";
  return <Text accessibilityLiveRegion="polite" style={{ color: palette.muted, marginVertical: 14, lineHeight: 21 }}>{needsVerification ? "Account restoration is paused until the server and account are verified. Open Account to continue; local logging is available." : sync.failures > 0 || sync.terminal ? "Account history has not finished restoring. Your local log is available; open Account for help." : "Restoring your account history. You can keep logging while it arrives."}</Text>;
}

export function SyncStatus() {
  const { sync, access } = useWorkspace();
  const palette = usePalette();
  const message = access.mode === "signed-out-hold" ? "Sign in to resume account sync."
    : sync?.lastCode === "SERVER_CHANGED" ? "Server changed. Open Account to verify where this log syncs."
    : sync?.lastCode === "ACCOUNT_MISMATCH" ? "Account verification is needed before sync can continue."
    : sync?.terminal ? "Account sync has stopped. Review your account."
    : sync?.conflicts.length ? "Some account changes need your choice."
    : sync && sync.consent === null ? "Enable cloud storage in Account to sync your edits."
    : sync && sync.failures >= 5 ? "Account sync needs attention. Your local log is available." : null;
  if (!message) return null;
  return <Pressable accessibilityRole="button" accessibilityLabel={`${message} Open Account`} onPress={() => router.push("/account")} style={{ paddingHorizontal: 22, paddingVertical: 12, borderTopWidth: 1, borderColor: palette.line, backgroundColor: palette.soft }}><Text style={{ color: palette.primary, fontSize: 13, lineHeight: 19 }}>{message} Open Account</Text></Pressable>;
}
