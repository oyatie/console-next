// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import type { ReadState } from "../../../lib/react/query-view";
import { KeyValue } from "../../../ui/key-value/key-value";
import { RrnEntry } from "./rrn-entry";
import { RrnValue } from "./rrn-value";
import s from "./rrn-field.module.css";

/** Both identity surfaces use the same first-entry state and field action. */
export function RrnField({ employeeId, employeeStatus, who, q, readable = true, editable = true, children }: {
  employeeId: string; employeeStatus: components["schemas"]["Employee"]["status"]; who: string;
  q: ReadState<components["schemas"]["EmployeeRrnStatus"]>; readable?: boolean; editable?: boolean; children?: ReactNode;
}) {
  const value = q.data;
  return <div className={s.field}><KeyValue items={[{
    key: "rrn", label: t("empCard.f.rrn"),
    value: <>
      {readable ? <QueryState q={q}>{status => status.recorded ? <RrnValue employeeId={employeeId} who={who} masked={status.masked ?? ""} /> : t("empCard.rrn.none")}</QueryState> : t("people.field.restricted")}
      {" "}{children}
    </>,
    action: readable && editable && !q.error && value?.can_record && !value.recorded && employeeStatus !== "EXITED" ? <RrnEntry employeeId={employeeId} who={who} /> : undefined,
  }]} /></div>;
}
