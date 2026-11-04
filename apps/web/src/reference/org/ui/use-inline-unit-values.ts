// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { todayKst } from "../../../lib/pure/today";
import { isDate } from "../../../ui/date/days";
import { defaultEffectiveDate } from "../api";

/** Every inline surface collects the same dated intent, including an honest reason after go-live. */
export function useInlineUnitValues(setup: boolean, asOf?: string) {
  const today = todayKst();
  const [values, set] = useState(() => ({ effectiveDate: defaultEffectiveDate(today, asOf), reason: "" }));
  const valid = setup || (isDate(values.effectiveDate) && values.effectiveDate >= today && !!values.reason.trim());
  return { today, values, set, valid };
}

