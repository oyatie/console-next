// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext } from "react";
import type { ReadState } from "../../lib/react/query-view";

/** Loaded sheet reads place their notices in the owning dialog, including chained reads. */
export const SheetReadContext = createContext<readonly ReadState[]>([]);
