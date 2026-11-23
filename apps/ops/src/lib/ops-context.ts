// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, useContext } from "react";
import type { OpsMe } from "./api";
import type { LiveStatusSnapshot } from "./live-sse";

export type OpsContextValue = {
  me: OpsMe;
  live: LiveStatusSnapshot;
  reportEvaluatedAt: (iso: string) => void;
};

export const OpsContext = createContext<OpsContextValue | null>(null);

export function useOpsContext(): OpsContextValue {
  const ctx = useContext(OpsContext);
  if (!ctx) throw new Error("useOpsContext must be used inside OpsContext.Provider");
  return ctx;
}
