// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { todayKst } from "../../../lib/pure/today";
import { isDate } from "../../../ui/date/days";
import { settingsQuery } from "../../settings/api";
import { policyRouted } from "../../settings/domain/policy";
import { defaultEffectiveDate } from "../api";

/** Inline edits carry a change-kind reason; only approval-routed changes need a written note. */
export function useInlineUnitValues(setup: boolean, asOf?: string, kind: "create" | "rename" = "create") {
  const today = todayKst();
  const [values, set] = useState(() => ({ effectiveDate: defaultEffectiveDate(today, asOf), reason: "" }));
  const [reasonOpen, setReasonOpen] = useState(false);
  const policy = useQuery(settingsQuery);
  const required = !setup && (!policy.isSuccess || policyRouted(policy.data.items, "org_structure"));
  const missingReason = required && !values.reason.trim();
  const valid = setup || (isDate(values.effectiveDate) && values.effectiveDate >= today && !missingReason);
  const attempt = () => {
    if (missingReason) setReasonOpen(true);
    return valid;
  };
  return { today, values, set, valid, required, missingReason, reasonOpen, setReasonOpen, attempt, code: kind === "create" ? "NEW" as const : "REORG" as const };
}
