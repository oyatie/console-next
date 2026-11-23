// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { ApiError, opsUsageQuery, type OpsUsageEntry } from "../api";

type OpsUsageRow = OpsUsageEntry & { _key: string };

const ISO_DATETIME = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function fmtIsoDateTimeKst(iso: string) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${ISO_DATETIME.format(d)} KST`;
}

function opsActionLabel(method: string) {
  switch (method.toUpperCase()) {
    case "GET": return t("access.person.opsLog.action.get");
    case "POST": return t("access.person.opsLog.action.post");
    case "PUT": return t("access.person.opsLog.action.put");
    case "PATCH": return t("access.person.opsLog.action.patch");
    case "DELETE": return t("access.person.opsLog.action.delete");
    default: return method;
  }
}

function opsResourceLabel(path: string) {
  const clean = path.split("?")[0] ?? path;
  if (/^\/api\/v\d+\/payroll\/runs\/[^/]+\/lock$/.test(clean)) return t("access.person.opsLog.resource.payrollLock");
  if (/^\/api\/v\d+\/payroll\b/.test(clean)) return t("access.person.opsLog.resource.payroll");
  if (/^\/api\/v\d+\/employees\b/.test(clean)) return t("access.person.opsLog.resource.employees");
  if (/^\/api\/v\d+\/access\b/.test(clean)) return t("access.person.opsLog.resource.access");
  if (/^\/api\/v\d+\/(?:org|entities|workplaces)\b/.test(clean)) return t("access.person.opsLog.resource.org");
  if (/^\/api\/v\d+\/attendance\b/.test(clean)) return t("access.person.opsLog.resource.attendance");
  if (/^\/api\/v\d+\/leave\b/.test(clean)) return t("access.person.opsLog.resource.leave");
  if (/^\/api\/v\d+\/approvals\b/.test(clean)) return t("access.person.opsLog.resource.approvals");
  if (/^\/api\/v\d+\/statutory\b/.test(clean)) return t("access.person.opsLog.resource.statutory");
  if (/^\/api\/v\d+\/(?:settings|period-locks)\b/.test(clean)) return t("access.person.opsLog.resource.settings");
  if (/^\/api\/(?:v\d+\/)?(?:audit|privacy)\b/.test(clean)) return t("access.person.opsLog.resource.audit");
  return t("access.person.opsLog.resource.other");
}

const columns: LongColumn<OpsUsageRow>[] = [
  { id: "at", card: "title", rowHeader: true, width: 220, header: t("access.person.opsLog.at"), cell: (row) => <bdi className="num">{fmtIsoDateTimeKst(row.at)}</bdi> },
  { id: "method", card: "fact", width: 96, header: t("access.person.opsLog.method"), cell: (row) => opsActionLabel(row.method) },
  { id: "path", card: "fact", width: "2fr", header: t("access.person.opsLog.path"), cell: (row) => <bdi title={`${row.method} ${row.path}`}>{opsResourceLabel(row.path)}</bdi> },
];

/** Emergency ops account usage log: hidden completely on 403, rendered with QueryState + LongTable otherwise. */
export function OpsUsageCard() {
  const usage = useQuery(opsUsageQuery(100));
  if (usage.error instanceof ApiError && usage.error.status === 403) return null;
  return (
    <Card title={t("access.person.opsLog.title")} flush>
      <QueryState q={usage} layout="list">
        {(entries) => {
          const rows: OpsUsageRow[] = entries.map((entry, index) => ({ ...entry, _key: `${entry.at}:${index}` }));
          return rows.length ? (
            <LongTable
              label={t("access.person.opsLog.title")}
              columns={columns}
              rows={rows}
              rowId={(row) => row._key}
              hasMore={false}
              onLoadMore={() => undefined}
              mobileLayout="compact"
              empty={null}
              findSlot={null}
            />
          ) : (
            <EmptyState title={t("access.person.opsLog.empty")} reason={null} />
          );
        }}
      </QueryState>
    </Card>
  );
}
