// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, createElement, useContext, type ReactNode } from "react";

type SheetDraftState = { dirty: boolean; discard: () => void; problem: "unreadable" | "unavailable" | null; restored: boolean };
const SheetDraftContext = createContext<SheetDraftState | undefined>(undefined);

export function SheetDraftProvider({ draft, children }: { draft: SheetDraftState; children?: ReactNode }) {
  return createElement(SheetDraftContext.Provider, { value: draft }, children);
}

export const useCurrentSheetDraft = () => useContext(SheetDraftContext);
