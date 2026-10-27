// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext } from "react";

/** A refused read inside a peek describes the record, rather than refusing the whole route. */
export const SidePanelReadContext = createContext(false);
