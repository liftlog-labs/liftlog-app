import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useColorScheme } from "react-native";
import type { SqlExecutor } from "../storage/sql";

export type PaletteId = "sage" | "coastal" | "heather" | "sand" | "club";
export type AppearanceMode = "system" | "light" | "dark";

export type Palette = {
  id: PaletteId;
  dark: boolean;
  background: string;
  surface: string;
  text: string;
  muted: string;
  soft: string;
  primary: string;
  onPrimary: string;
  line: string;
  warm: string;
  warmInk: string;
};

const PALETTE_KEY = "appearance_palette";
const MODE_KEY = "appearance_mode";

const LIGHT: Record<PaletteId, Palette> = {
  sage: tone("sage", false, "#F4F5F0", "#20382F", "#586A61", "#E4ECE1", "#285C49", "#D9E1D8", "#FFFFFF", "#F1DECB", "#775131"),
  coastal: tone("coastal", false, "#F3F6F7", "#203744", "#526875", "#E1EBEF", "#295D78", "#D8E2E7", "#FFFFFF", "#F1DECB", "#775131"),
  heather: tone("heather", false, "#F7F4F7", "#392B40", "#706074", "#EDE4EE", "#6E466C", "#E2DAE5", "#FFFFFF", "#F1DECB", "#775131"),
  sand: tone("sand", false, "#F6F4EF", "#303943", "#62686E", "#E7E5DF", "#374F65", "#DEDCD5", "#FFFFFF", "#F1DECB", "#775131"),
  club: tone("club", false, "#F6F7FA", "#182238", "#667084", "#E4EAFF", "#365DE3", "#E1E5ED", "#FFFFFF", "#F1DECB", "#775131"),
};

const DARK: Record<PaletteId, Palette> = {
  sage: tone("sage", true, "#18211E", "#EBF3EF", "#B1C1B8", "#30483B", "#A7CBB4", "#44564A", "#25312C", "#493C2F", "#F0CEAA", "#15281C"),
  coastal: tone("coastal", true, "#121C22", "#E8F3F7", "#A9C0CB", "#234556", "#B7D4E4", "#3A5160", "#1B2830", "#493C2F", "#F0CEAA", "#102430"),
  heather: tone("heather", true, "#1B1520", "#F6F0F6", "#CDBDCF", "#3E3046", "#E0C4DE", "#4C3E52", "#281F2C", "#493C2F", "#F0CEAA", "#2A1828"),
  sand: tone("sand", true, "#1A1C1E", "#F4F2EC", "#C2C0B8", "#3A4048", "#D5DEE8", "#454C54", "#26292C", "#493C2F", "#F0CEAA", "#1A2430"),
  club: tone("club", true, "#121722", "#EEF2FA", "#B4BDCC", "#2A3A62", "#C5D2FB", "#3A4660", "#1C2433", "#493C2F", "#F0CEAA", "#152038"),
};

export const paletteChoices: { id: PaletteId; name: string; detail: string; swatches: [string, string, string] }[] = [
  { id: "sage", name: "Sage & pine", detail: "Default · Calm and grounded", swatches: [LIGHT.sage.background, LIGHT.sage.soft, LIGHT.sage.primary] },
  { id: "coastal", name: "Coastal blue", detail: "Cool and clear", swatches: [LIGHT.coastal.background, LIGHT.coastal.soft, LIGHT.coastal.primary] },
  { id: "heather", name: "Heather & plum", detail: "Soft and warm", swatches: [LIGHT.heather.background, LIGHT.heather.soft, LIGHT.heather.primary] },
  { id: "sand", name: "Sand & ink", detail: "Quiet and neutral", swatches: [LIGHT.sand.background, LIGHT.sand.soft, LIGHT.sand.primary] },
  { id: "club", name: "Training club blue", detail: "Original · Bold and clear", swatches: [LIGHT.club.background, LIGHT.club.soft, LIGHT.club.primary] },
];

export const fallbackPalette = LIGHT.sage;

type AppearanceValue = {
  palette: Palette;
  paletteId: PaletteId;
  mode: AppearanceMode;
  setPaletteId: (id: PaletteId) => void;
  setMode: (mode: AppearanceMode) => void;
  reload: () => void;
};

const AppearanceContext = createContext<AppearanceValue | null>(null);

export function AppearanceProvider({ db, children }: { db: SqlExecutor; children: ReactNode }) {
  const stored = readStored(db);
  const [paletteId, setPaletteIdState] = useState<PaletteId>(stored.paletteId);
  const [mode, setModeState] = useState<AppearanceMode>(stored.mode);
  const system = useColorScheme();
  const dark = mode === "dark" || (mode === "system" && system === "dark");
  const palette = (dark ? DARK : LIGHT)[paletteId];

  const value = useMemo<AppearanceValue>(
    () => ({
      palette,
      paletteId,
      mode,
      setPaletteId: (id) => {
        writePref(db, PALETTE_KEY, id);
        setPaletteIdState(id);
      },
      setMode: (next) => {
        writePref(db, MODE_KEY, next);
        setModeState(next);
      },
      reload: () => {
        const next = readStored(db);
        setPaletteIdState(next.paletteId);
        setModeState(next.mode);
      },
    }),
    [db, mode, palette, paletteId],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance(): AppearanceValue {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("Appearance missing");
  return value;
}

export function usePalette(): Palette {
  return useAppearance().palette;
}

export function appearanceSummary(id: PaletteId, mode: AppearanceMode): string {
  const name = paletteChoices.find((choice) => choice.id === id)?.name ?? "Sage & pine";
  const modeLabel = mode === "system" ? "System" : mode === "light" ? "Light" : "Dark";
  return `${name} · ${modeLabel}`;
}

function tone(
  id: PaletteId,
  dark: boolean,
  background: string,
  text: string,
  muted: string,
  soft: string,
  primary: string,
  line: string,
  surface: string,
  warm: string,
  warmInk: string,
  onPrimary = dark ? "#15281C" : "#FFFFFF",
): Palette {
  return { id, dark, background, surface, text, muted, soft, primary, onPrimary, line, warm, warmInk };
}

function readStored(db: SqlExecutor): { paletteId: PaletteId; mode: AppearanceMode } {
  const paletteValue = db.get<{ value: string }>("SELECT value FROM preference WHERE key = ?", [PALETTE_KEY])?.value;
  const modeValue = db.get<{ value: string }>("SELECT value FROM preference WHERE key = ?", [MODE_KEY])?.value;
  return {
    paletteId: isPaletteId(paletteValue) ? paletteValue : "sage",
    mode: isMode(modeValue) ? modeValue : "system",
  };
}

function writePref(db: SqlExecutor, key: string, value: string) {
  db.run(
    `INSERT INTO preference (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, value],
  );
}

function isPaletteId(value: string | undefined): value is PaletteId {
  return value === "sage" || value === "coastal" || value === "heather" || value === "sand" || value === "club";
}

function isMode(value: string | undefined): value is AppearanceMode {
  return value === "system" || value === "light" || value === "dark";
}
