// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { AuditTabs } from "../../../reference/audit/ui/audit-tabs";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable } from "../../../ui/long-table/long-table";
import { Worklist } from "../../../ui/patterns/worklist";
import { findingsQuery } from "../api";
import { findingCode, findingDetector } from "../present";
import { FindingRecord } from "./finding-record";

export function Findings() {
  const q = useQuery(findingsQuery);
  const [selection, select] = useState<string | null>();
  const desktop = useIsDesktop();
  const rows = q.data ?? [];
  const selected = selection === undefined && desktop ? rows[0] : rows.find(row => row.id === selection);
  return <Worklist q={q} head={{ title: t("audit.findings.title"), titleId: "findings-title" }} tabs={<AuditTabs />}
    list={rows.length ? <LongTable label={t("audit.findings.title")} rows={rows} rowId={row => row.id}
      onRowAction={select} activeRowId={selected?.id} total={rows.length} hasMore={false} onLoadMore={() => {}}
      density="compact" mobileLayout="compact" empty={t("audit.findings.empty")} columns={[
        { id: "detector", header: t("audit.findings.detector"), rowHeader: true, card: "title", width: "2fr", cell: row => findingDetector(row.detector_id) },
        { id: "severity", header: t("audit.findings.severity"), card: "fact", width: "1fr", cell: row => findingCode(row.severity) },
        { id: "status", header: t("audit.findings.status"), card: "fact", width: "1fr", cell: row => findingCode(row.status) },
        { id: "detected", header: t("audit.findings.detected"), card: "omit", width: 178, cell: row => fmtDateTime(row.detected_at) },
      ]} /> : <EmptyState title={t("audit.findings.empty")} reason={t("audit.findings.emptyReason")} />}
    record={selected && { id: selected.id, label: t("audit.findings.record"), title: findingDetector(selected.detector_id),
      meta: findingCode(selected.status), onClose: () => select(null),
      children: <FindingRecord key={selected.id} row={selected} /> }} />;
}
