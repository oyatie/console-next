// SPDX-License-Identifier: LicenseRef-Proprietary
import { createContext, useContext } from "react";

/** The structure page shares the chart's existing server-derived draft decision. */
export const UnitEdit = createContext<boolean | undefined>(undefined);
export function useUnitEdit(setup: boolean, readOnly = false) {
  const decision = useContext(UnitEdit);
  return !readOnly && (decision ?? setup);
}
