// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, type ReactNode } from "react";

export const PageScope = createContext({ landmark: false, embedded: false });
export const PageHeadingLevel = createContext<1 | 2>(1);

/** Tenant phase supplied by the shell; only the primary page head consumes it. */
export const PagePhase = createContext<ReactNode>(null);
