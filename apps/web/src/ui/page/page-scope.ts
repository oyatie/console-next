// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, type ReactNode } from "react";

export const PageScope = createContext({ landmark: false, embedded: false });
export const PageHeadingLevel = createContext<1 | 2>(1);

/** Shell phase readiness and the notice consumed by the primary page head. */
export const PagePhase = createContext<{ slot: ReactNode; settled: boolean }>({ slot: null, settled: true });
