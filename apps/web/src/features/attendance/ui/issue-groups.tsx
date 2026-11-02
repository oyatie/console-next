// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { Table } from "../../../ui/table";
import { Card } from "../../../ui/card/card";
import type { IssueGroup, Mark } from "../api";
import { dateText } from "../present";

/** Counts cover the server's whole scope, including rows folded out of the board. */
export function IssueGroups({ groups, selected, onSelect }: { groups: IssueGroup[]; selected?: string; onSelect: (mark: Mark) => void }) {
  return <Card title={t("attendanceOverview.issues.groups")}><Table label={t("attendanceOverview.issues.groups")} rows={groups.filter(g => g.count > 0)} rowId={g => g.kind}
    selected={selected} onSelect={id => onSelect(id as Mark)} columns={[
      { header: t("attendance.col.kind"), card: "title", rowHeader: true, cell: g => t(`attendanceRecords.mark.${g.kind}`) },
      { header: t("attendanceOverview.issues.count"), card: "fact", cell: g => t("attendance.count", { count: g.count }) },
      { header: t("attendanceOverview.issues.oldest"), card: "fact", cell: g => dateText(g.earliest_date) },
    ]} /></Card>;
}
