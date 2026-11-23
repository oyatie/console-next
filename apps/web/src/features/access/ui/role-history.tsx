// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import type { ReadState } from "../../../lib/react/query-view";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { fromLines } from "../domain/grid";
import type { roleVersionsQuery } from "../api";
import { linesText } from "../present";
import { RoleDiff } from "./role-diff";
import { useReasons } from "./use-reasons";
import s from "./access.module.css";

type RoleVersionsData = Awaited<ReturnType<ReturnType<typeof roleVersionsQuery>["queryFn"]>>;

/** Role version history tab (newest first) with expandable RoleDiff against the preceding version. */
export function RoleHistory({ versions, order }: { versions: ReadState<RoleVersionsData>; order: readonly string[] }) {
  const reasons = useReasons();
  const [expanded, setExpanded] = useState<number | null>(null);
  return (
    <Card title={t("access.role.versions")} flush>
      <QueryState q={versions} layout="list">
        {(rows) => {
          if (!rows.length) return <EmptyState title={t("access.role.history.empty")} reason={null} />;
          const active = expanded === null ? undefined : rows.findIndex((r) => r.version === expanded);
          const selected = active !== undefined && active >= 0 ? rows[active] : undefined;
          const prev = active !== undefined && active >= 0 ? rows[active + 1] : undefined;
          return (
            <div className={s.stack}>
              <Table
                label={t("access.role.versions")}
                rows={rows}
                rowId={(row) => String(row.version)}
                columns={[
                  { card: "title", rowHeader: true, header: t("access.role.version.column"), fit: true, cell: (row) => t("access.role.version", { version: row.version }) },
                  { card: "fact", header: t("access.roles.col.name"), cell: (row) => row.name_ko },
                  { card: "fact", header: t("access.roles.col.lines"), cell: (row) => linesText(row.lines) },
                  { card: "fact", header: t("access.role.version.at"), cell: (row) => fmtDateTime(row.created_at) },
                  { card: "fact", header: t("access.grant.reason"), cell: (row) => reasons.codes.find((c) => c.code === row.reason_code)?.label ?? row.reason_code ?? t("access.role.version.noReason") },
                  {
                    card: "action",
                    header: <div className="sr-only">{t("access.roles.col.actions")}</div>,
                    fit: true,
                    cell: (row) => {
                      const idx = rows.findIndex((r) => r.version === row.version);
                      const hasPrev = idx >= 0 && idx + 1 < rows.length;
                      return hasPrev ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded === row.version}
                          onClick={() => setExpanded((cur) => (cur === row.version ? null : row.version))}
                        >
                          {t("access.role.history.compare")}
                        </Button>
                      ) : (
                        <div className="muted">{t("access.role.history.initial")}</div>
                      );
                    },
                  },
                ]}
              />
              {selected && prev && (
                <div className={s.pad}>
                  <RoleDiff before={fromLines(prev.lines)} after={fromLines(selected.lines)} order={order} />
                </div>
              )}
            </div>
          );
        }}
      </QueryState>
    </Card>
  );
}
