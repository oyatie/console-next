// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, createElement, useContext, type ReactNode } from "react";
import { useDraft, type DraftFields, type DraftOptions } from "../../lib/react/use-draft";

type SheetDraftState = { dirty: boolean; discard: () => void; problem: "unreadable" | "unavailable" | null; restored: boolean };
const SheetDraftContext = createContext<SheetDraftState | undefined>(undefined);

/** Account- and record-scoped form state for a Sheet that may be closed and reopened. */
export const useSheetDraft = <T extends DraftFields>(options: DraftOptions<T>) => useDraft(options);

export function SheetDraftProvider({ draft, children }: { draft: SheetDraftState; children?: ReactNode }) {
  return createElement(SheetDraftContext.Provider, { value: draft }, children);
}

export const useCurrentSheetDraft = () => useContext(SheetDraftContext);
