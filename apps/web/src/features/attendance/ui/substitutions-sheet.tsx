// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button-base";
import { Chip } from "../../../ui/chip";
import { Sheet } from "../../../ui/sheet/sheet";
import { Table } from "../../../ui/table";
import { substitutionsQuery, type AttendanceSubstitution } from "../api";
import { AssignSubstitutionComposer, CancelSubstitutionComposer } from "./substitutions-composers";
import s from "./attendance-console.module.css";

export function SubstitutionsSheet({
  date,
  branchId,
  onClose,
}: {
  date: string;
  branchId?: string;
  onClose: () => void;
}) {
  const q = useQuery({ ...substitutionsQuery({ work_date: date, branch_id: branchId }), retry: false });
  const [mode, setMode] = useState<{ kind: "assign" } | { kind: "cancel"; row: AttendanceSubstitution } | null>(null);

  if (mode?.kind === "assign") {
    return <AssignSubstitutionComposer date={date} branchId={branchId} onClose={() => setMode(null)} />;
  }
  if (mode?.kind === "cancel") {
    return (
      <CancelSubstitutionComposer
        substitutionId={mode.row.id}
        summary={`${mode.row.covered_name} → ${mode.row.worker_name}`}
        onClose={() => setMode(null)}
      />
    );
  }

  return (
    <Sheet
      open
      title={t("attendance.sub.title")}
      subtitle={date}
      consequence={t("attendance.sub.title")}
      onClose={onClose}
      actions={
        <Button size="sm" variant="primary" className={s.nowrap} onClick={() => setMode({ kind: "assign" })}>
          {t("attendance.sub.assignButton")}
        </Button>
      }
    >
      <QueryState q={q} inline>
        {(data) =>
          data.items.length === 0 ? (
            <p className="muted">{t("attendance.sub.empty")}</p>
          ) : (
            <Table<AttendanceSubstitution>
              label={t("attendance.sub.title")}
              rows={data.items}
              rowId={(row) => row.id}
              density="compact"
              mobileLayout="compact"
              columns={[
                { header: t("attendance.sub.coveredEmployee"), card: "title", cell: (row) => row.covered_name },
                { header: t("attendance.sub.workerEmployee"), card: "fact", cell: (row) => row.worker_name },
                { header: t("attendance.sub.role"), card: "fact", cell: (row) => `${row.site} · ${row.role}` },
                {
                  header: t("attendance.col.state"),
                  card: "status",
                  cell: (row) => (
                    <Chip tone={row.status === "ASSIGNED" ? "ok" : "neutral"}>
                      {t(`attendance.sub.status.${row.status}`)}
                    </Chip>
                  ),
                },
                {
                  header: t("attendance.sub.cancelButton"),
                  card: "action",
                  cell: (row) =>
                    row.status === "ASSIGNED" ? (
                      <Button size="sm" variant="ghost" className={s.nowrap} onClick={() => setMode({ kind: "cancel", row })}>
                        {t("attendance.sub.cancelButton")}
                      </Button>
                    ) : (
                      "—"
                    ),
                },
              ]}
            />
          )
        }
      </QueryState>
    </Sheet>
  );
}
