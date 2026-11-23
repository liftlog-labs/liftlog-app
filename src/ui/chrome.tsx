import { router } from "expo-router";
import type { ReactNode } from "react";
import { Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Icon, type IconName } from "./icons";
import { SyncStatus } from "./syncStatus";
import { usePalette } from "./theme";

export const screenPadding = { paddingHorizontal: 22, paddingTop: 10, paddingBottom: 28 };

export function serifFamily(): string {
  return Platform.OS === "android" ? "serif" : "Georgia";
}

export function Screen({ children, footer, topSafeArea = true }: { children: ReactNode; footer?: ReactNode; topSafeArea?: boolean }) {
  const palette = usePalette();
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={topSafeArea ? ["top", "left", "right"] : []}>
      {children}
      <SyncStatus />
      {footer}
    </SafeAreaView>
  );
}

export function BrandBar() {
  const palette = usePalette();
  return (
    <View style={{ minHeight: 64, paddingHorizontal: 22, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Text style={{ color: palette.text, fontSize: 25, fontWeight: "800", letterSpacing: -1.2 }} maxFontSizeMultiplier={1.4}>
        liftlog.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings"
        onPress={() => router.push("/settings")}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          borderRadius: 22,
          backgroundColor: palette.surface,
          borderWidth: 1,
          borderColor: palette.line,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <Icon name="settings" color={palette.text} />
      </Pressable>
    </View>
  );
}

export function NavBar({ title }: { title: string }) {
  const palette = usePalette();
  return (
    <View style={{ minHeight: 56, paddingHorizontal: 12, flexDirection: "row", alignItems: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Back"
        onPress={() => (router.canGoBack() ? router.back() : router.replace("/"))}
        style={({ pressed }) => ({
          minWidth: 44,
          minHeight: 44,
          paddingHorizontal: 6,
          flexDirection: "row",
          alignItems: "center",
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <Icon name="back" color={palette.primary} />
      </Pressable>
      <Text style={{ flex: 1, textAlign: "center", color: palette.text, fontSize: 17, fontWeight: "600" }} numberOfLines={1}>
        {title}
      </Text>
      <View style={{ width: 44 }} />
    </View>
  );
}

export function PageHeading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  const palette = usePalette();
  const { width } = useWindowDimensions();
  const size = width < 360 ? 30 : 34;
  return (
    <View style={{ marginBottom: 23 }}>
      {eyebrow ? <Text style={{ color: palette.muted, fontSize: 13, marginBottom: 8 }}>{eyebrow}</Text> : null}
      <Text accessibilityRole="header" style={{ color: palette.text, fontFamily: serifFamily(), fontSize: size, lineHeight: Math.round(size * 1.12), letterSpacing: -1 }}>
        {title}
      </Text>
    </View>
  );
}

export function SectionTitle({ children }: { children: string }) {
  const palette = usePalette();
  return <Text style={{ color: palette.text, fontSize: 17, fontWeight: "700" }}>{children}</Text>;
}

export function GroupLabel({ children }: { children: string }) {
  const palette = usePalette();
  return <Text style={{ color: palette.muted, fontSize: 12, marginTop: 8, marginBottom: 3 }}>{children}</Text>;
}

export function Muted({ children, size = 13 }: { children: ReactNode; size?: number }) {
  const palette = usePalette();
  return <Text style={{ color: palette.muted, fontSize: size }}>{children}</Text>;
}

export function Tile({ icon, size = 43, background }: { icon: IconName; size?: number; background?: string }) {
  const palette = usePalette();
  const large = size >= 64;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: large ? 22 : 13,
        backgroundColor: background ?? palette.surface,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Icon name={icon} color={palette.primary} size={large ? 28 : 21} />
    </View>
  );
}

export function Pill({ label, icon, warm = false }: { label: string; icon?: IconName; warm?: boolean }) {
  const palette = usePalette();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingVertical: 5,
        paddingHorizontal: 9,
        borderRadius: 8,
        backgroundColor: warm ? palette.warm : palette.surface,
      }}
    >
      {icon ? <Icon name={icon} color={warm ? palette.warmInk : palette.primary} size={12} /> : null}
      <Text style={{ color: warm ? palette.warmInk : palette.primary, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function Notice({ title, body }: { title: string; body: string }) {
  const palette = usePalette();
  return (
    <View style={{ flexDirection: "row", gap: 12, backgroundColor: palette.soft, borderRadius: 16, padding: 15, marginTop: 18 }}>
      <Icon name="sprout" color={palette.primary} />
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.text, fontSize: 13, fontWeight: "700" }}>{title}</Text>
        <Text style={{ color: palette.muted, fontSize: 13, marginTop: 5 }}>{body}</Text>
      </View>
    </View>
  );
}

export function WarmNote({ title, body }: { title: string; body: string }) {
  const palette = usePalette();
  return (
    <View style={{ backgroundColor: palette.warm, borderRadius: 14, padding: 14, marginTop: 18 }}>
      <Text style={{ color: palette.warmInk, fontSize: 13, fontWeight: "700" }}>{title}</Text>
      <Text style={{ color: palette.warmInk, fontSize: 13, marginTop: 8 }}>{body}</Text>
    </View>
  );
}

export function Panel({ children }: { children: ReactNode }) {
  const palette = usePalette();
  return (
    <View style={{ backgroundColor: palette.surface, borderWidth: 1, borderColor: palette.line, borderRadius: 19, padding: 18, marginTop: 16 }}>
      {children}
    </View>
  );
}

export function EmptyState({ icon, title, body, action }: { icon: IconName; title: string; body: string; action?: ReactNode }) {
  const palette = usePalette();
  const { width } = useWindowDimensions();
  const size = width < 360 ? 28 : 30;
  return (
    <View style={{ width: "100%", alignItems: "center", paddingHorizontal: 12, paddingTop: 48, paddingBottom: 24 }}>
      <Tile icon={icon} size={70} background={palette.soft} />
      <Text
        accessibilityRole="header"
        style={{
          color: palette.text,
          fontFamily: serifFamily(),
          fontSize: size,
          lineHeight: Math.round(size * 1.15),
          letterSpacing: -0.6,
          textAlign: "center",
          marginTop: 22,
          marginBottom: 13,
        }}
      >
        {title}
      </Text>
      <Text style={{ color: palette.muted, fontSize: 14, textAlign: "center", maxWidth: 280 }}>{body}</Text>
      {action ? <View style={{ alignSelf: "stretch", marginTop: 8 }}>{action}</View> : null}
    </View>
  );
}
