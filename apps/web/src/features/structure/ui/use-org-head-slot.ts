// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, useContext } from "react";

export const OrgHeadSlotContext = createContext<HTMLElement | null>(null);
export const useOrgHeadSlot = () => useContext(OrgHeadSlotContext);
