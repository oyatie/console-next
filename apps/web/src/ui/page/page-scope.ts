// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, type ReactNode } from "react";

export const PageScope = createContext({ landmark: false, embedded: false });
export const PageHeadingLevel = createContext<1 | 2>(1);

/** When the phone top bar renders the page's single `<h1>`, screens inside `<main>` shift their heading to `<h2>`. */
export const PagePhoneHeader = createContext<{ shellOwnsH1: boolean }>({ shellOwnsH1: false });

/** Shell phase readiness and the notice consumed by the primary page head. */
export const PagePhase = createContext<{ slot: ReactNode; settled: boolean }>({ slot: null, settled: true });
