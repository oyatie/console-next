// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext } from "react";
import type { ChartNode } from "../domain/model";

/** The exact rows shown in the list, shared with its page's export dialog. */
export const RegistryExportContext = createContext<readonly ChartNode[] | null>(null);
