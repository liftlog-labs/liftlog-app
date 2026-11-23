import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import type { BackupPreview } from "../modules/backup";

type Draft = { raw: string; preview: BackupPreview };

type RestoreDraftValue = {
  draft: Draft | null;
  setDraft: (draft: Draft | null) => void;
};

const RestoreDraftContext = createContext<RestoreDraftValue | null>(null);

export function RestoreDraftProvider({ children }: { children: ReactNode }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const value = useMemo(() => ({ draft, setDraft }), [draft]);
  return <RestoreDraftContext.Provider value={value}>{children}</RestoreDraftContext.Provider>;
}

export function useRestoreDraft(): RestoreDraftValue {
  const value = useContext(RestoreDraftContext);
  if (!value) throw new Error("Restore draft missing");
  return value;
}
