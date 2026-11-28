// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { Chip } from "../../../ui/chip";
import { FilingDeadline } from "../../../reference/statutory/ui/filing-deadline";
import type { CaseItem } from "../api/lifecycle-trail";

type ItemDates = Pick<CaseItem, "opens_on" | "opens_in_days" | "due_date" | "due_in_days" | "due_disposition"> & { basis?: CaseItem["basis"] };
export function ItemWindow({ item, rules, deadline }: { item: ItemDates; rules?: { opens: ReactNode; due: ReactNode }; deadline?: ReactNode }) {
  return <div className="row">
    <span>{t("statutory.opens")} {item.opens_on ? <time dateTime={item.opens_on}>{fmtDate(item.opens_on)}</time> : rules?.opens ?? t("lifecycle.trail.opensUnknown")}</span>
    {item.opens_in_days !== null && item.opens_in_days > 0 && <Chip>{t("lifecycle.trail.startsIn", { days: item.opens_in_days })}</Chip>}
    <span aria-hidden="true">·</span><span>{(rules ? rules.due !== t("statutory.unknown") : item.due_disposition !== "UNKNOWN" && item.due_date) && t("statutory.deadline")} {rules?.due}</span>
    {!rules && (deadline ?? <FilingDeadline task={{ due_date: item.due_disposition === "UNKNOWN" ? null : item.due_date, due_in_days: item.due_in_days, deadline_status: item.basis?.legal_review_required === true ? "HOLD" : item.due_disposition }} />)}
  </div>;
}
