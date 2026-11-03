// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable } from "../../../ui/long-table/long-table";
import { grantsQuery } from "../api";
import { enforcementText, periodText, storedScope } from "../present";
import { AccessHead } from "./access-head";

export function AccessReviewPage() {
  const grants = useQuery(grantsQuery());
  const [find, setFind] = useState("");
  return <div className="page">
    <AccessHead />
    <Card title={t("accessReview.title")} flush>
      <QueryState q={grants} layout="list">{data => {
        if (!data.items.length) return <EmptyState title={t("accessReview.empty")} reason={t("accessReview.emptyReason")} />;
        const needle = find.trim().toLocaleLowerCase();
        const rows = data.items.filter(g => !needle || [g.account_display_name, g.account_employee_number, g.account_unit, g.role_name_ko].some(value => value?.toLocaleLowerCase().includes(needle)));
        return <LongTable label={t("accessReview.table")} rows={rows} rowId={g => g.id} total={rows.length} hasMore={false} onLoadMore={() => {}}
          empty={t("accessReview.noMatch")} find={{ label: t("accessReview.find"), onFind: setFind, defaultValue: find }}
          columns={[
            { id: "person", header: t("accessReview.person"), card: "title", rowHeader: true, cell: g => <Link to="/access/people/$accountId" params={{ accountId: g.account_id }}>{g.account_display_name ?? g.account_employee_number ?? g.account_id}</Link> },
            { id: "number", header: t("accessReview.number"), card: "fact", cell: g => g.account_employee_number ?? "—" },
            { id: "role", header: t("accessReview.role"), card: "fact", cell: g => g.role_name_ko },
            { id: "scope", header: t("accessReview.scope"), card: "fact", cell: g => storedScope(g.scope) },
            { id: "period", header: t("accessReview.period"), card: "fact", cell: g => periodText(g) },
            { id: "state", header: t("accessReview.state"), card: "status", cell: g => <Chip tone={g.enforcement === "ENFORCED" ? "ok" : "neutral"}>{enforcementText(g.enforcement)}</Chip> },
          ]} />;
      }}</QueryState>
    </Card>
  </div>;
}
