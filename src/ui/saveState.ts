import type { Result } from "../shared/result";

export type SavePhase = "idle" | "saving" | "saved" | "error";

export function afterSaveAttempt<T>(draft: T, result: Result<unknown>): {
  draft: T;
  phase: SavePhase;
  message: string | null;
  clearInputs: boolean;
} {
  if (result.ok) {
    return { draft, phase: "saved", message: "Saved", clearInputs: true };
  }
  return {
    draft,
    phase: "error",
    message: "Set not saved. Try again.",
    clearInputs: false,
  };
}
