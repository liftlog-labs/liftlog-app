import type { ReactNode } from "react";
import { Pressable, Text, TextInput, View, type KeyboardTypeOptions } from "react-native";
import { Icon, type IconName } from "./icons";
import { usePalette } from "./theme";

export function PrimaryButton({ label, icon, onPress, disabled = false }: { label: string; icon?: IconName; onPress: () => void; disabled?: boolean }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 52,
        borderRadius: 14,
        backgroundColor: palette.primary,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 10,
        paddingHorizontal: 16,
        marginTop: 20,
        opacity: disabled ? 0.55 : pressed ? 0.75 : 1,
      })}
    >
      {icon ? <Icon name={icon} color={palette.onPrimary} size={18} /> : null}
      <Text style={{ color: palette.onPrimary, fontSize: 16, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function SecondaryButton({ label, icon, onPress }: { label: string; icon?: IconName; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 48,
        borderRadius: 14,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.surface,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 8,
        paddingHorizontal: 16,
        marginTop: 12,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {icon ? <Icon name={icon} color={palette.primary} size={18} /> : null}
      <Text style={{ color: palette.primary, fontSize: 16, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function TextAction({ label, onPress }: { label: string; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ minHeight: 44, justifyContent: "center", opacity: pressed ? 0.75 : 1 })}>
      <Text style={{ color: palette.primary, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function FieldLabel({ children }: { children: string }) {
  const palette = usePalette();
  return <Text style={{ color: palette.text, fontSize: 13, fontWeight: "600", marginTop: 17, marginBottom: 8 }}>{children}</Text>;
}

export function TextField({
  label,
  value,
  onChangeText,
  keyboard = "default",
  placeholder,
  secure = false,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboard?: KeyboardTypeOptions;
  placeholder?: string;
  secure?: boolean;
}) {
  const palette = usePalette();
  return (
    <TextInput
      accessibilityLabel={label}
      placeholder={placeholder}
      placeholderTextColor={palette.muted}
      value={value}
      onChangeText={onChangeText}
      keyboardType={keyboard}
      autoCorrect={false}
      autoCapitalize={secure || keyboard === "email-address" ? "none" : "sentences"}
      secureTextEntry={secure}
      textContentType={secure ? "password" : undefined}
      autoComplete={secure ? "password" : undefined}
      style={{
        minHeight: 50,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.surface,
        color: palette.text,
        borderRadius: 13,
        paddingHorizontal: 14,
        fontSize: 17,
        fontVariant: ["tabular-nums"],
      }}
    />
  );
}

export function ToggleRow({ label, value, onValueChange }: { label: string; value: boolean; onValueChange: (value: boolean) => void }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="switch"
      accessibilityLabel={label}
      accessibilityState={{ checked: value }}
      onPress={() => onValueChange(!value)}
      style={({ pressed }) => ({
        minHeight: 44,
        marginTop: 13,
        paddingVertical: 8,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Text style={{ color: palette.text, fontSize: 15 }}>{label}</Text>
      <View style={{ width: 44, height: 26, borderRadius: 20, backgroundColor: value ? palette.primary : palette.line, padding: 3, alignItems: value ? "flex-end" : "flex-start" }}>
        <View style={{ width: 20, height: 20, borderRadius: 10, backgroundColor: value ? palette.onPrimary : palette.surface }} />
      </View>
    </Pressable>
  );
}

export function ChoiceCard({
  title,
  detail,
  selected,
  onPress,
  leading,
}: {
  title: string;
  detail: string;
  selected: boolean;
  onPress: () => void;
  leading: ReactNode;
}) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={`${title}. ${detail}`}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 69,
        marginTop: 10,
        borderRadius: 15,
        borderWidth: 2,
        borderColor: selected ? palette.primary : palette.line,
        backgroundColor: selected ? palette.soft : palette.surface,
        paddingHorizontal: 14,
        paddingVertical: 12,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      {leading}
      <View style={{ flex: 1 }}>
        <Text style={{ color: palette.text, fontSize: 14, fontWeight: "700" }}>{title}</Text>
        <Text style={{ color: palette.muted, fontSize: 11, marginTop: 3 }}>{detail}</Text>
      </View>
      {selected ? <Icon name="saved" color={palette.primary} size={18} /> : null}
    </Pressable>
  );
}

export function FilterChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  const palette = usePalette();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingHorizontal: 14,
        borderRadius: 10,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: selected ? palette.primary : palette.surface,
        borderWidth: 1,
        borderColor: selected ? palette.primary : palette.line,
        opacity: pressed ? 0.75 : 1,
      })}
    >
      <Text style={{ color: selected ? palette.onPrimary : palette.text, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}
