// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Card } from "../../../ui/card/card";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { StatRow } from "../../../ui/key-value/key-value";
import { LongTable } from "../../../ui/long-table/long-table";
import { grantsQuery, meQuery, type AccessGrant } from "../api";
import { enforcementText, periodText, storedScope } from "../present";
import { AccessHead } from "./access-head";
import { AccessReviewDetailSheet } from "./access-review-detail-sheet";
import { AccessReviewConsole } from "./access-review-inspector";

type FilterState = "all" | "enforced" | "pending";

export function AccessReviewPage() {
  const me = useQuery(meQuery);
  const grants = useQuery(grantsQuery());
  const [find, setFind] = useState("");
  const [stateFilter, setStateFilter] = useState<FilterState>("all");
  const [selected, setSelected] = useState<AccessGrant | null>(null);

  const items = grants.data?.items ?? [];
  const enforcedCount = items.filter(g => g.enforcement === "ENFORCED").length;
  const pendingCount = items.length - enforcedCount;
  const needle = find.trim().toLocaleLowerCase();
  const rows = items.filter(g => {
    if (stateFilter === "enforced" && g.enforcement !== "ENFORCED") return false;
    if (stateFilter === "pending" && g.enforcement === "ENFORCED") return false;
    return !needle || [g.account_display_name, g.account_employee_number, g.account_unit, g.role_name_ko].some(value => value?.toLocaleLowerCase().includes(needle));
  });

  const phase = !me.error ? me.data?.phase : undefined;
  const statItems = [
    { key: "all", label: t("accessReview.stat.all"), value: fmtNumber(items.length), active: stateFilter === "all", onPress: () => setStateFilter("all") },
    { key: "enforced", label: t("accessReview.stat.enforced"), value: fmtNumber(enforcedCount), active: stateFilter === "enforced", onPress: () => setStateFilter("enforced") },
    { key: "pending", label: t("accessReview.stat.pending"), value: fmtNumber(pendingCount), active: stateFilter === "pending", onPress: () => setStateFilter("pending") },
  ];

  const renderBaseline = () => (
    <div className="page" data-access-page="">
      <AccessHead />
      <QueryState q={grants} layout="list">{data => <Card title={t("accessReview.title")} flush>
        {!data.items.length
          ? <EmptyState title={t("accessReview.empty")} reason={t("accessReview.emptyReason")} />
          : <>
              <StatRow label={t("accessReview.title")} items={statItems} />
              <LongTable label={t("accessReview.table")} rows={rows} rowId={g => g.id} total={rows.length} hasMore={false} onLoadMore={() => {}}
                activeRowId={selected?.id}
                onRowAction={id => setSelected(rows.find(row => row.id === id) ?? null)}
                empty={t("accessReview.noMatch")} find={{ label: t("accessReview.find"), onFind: setFind, defaultValue: find }}
                columns={[
                  { id: "person", header: t("accessReview.person"), card: "title", rowHeader: true, cell: g => <Link to="/access/people/$accountId" params={{ accountId: g.account_id }}>{g.account_display_name ?? g.account_employee_number ?? g.account_id}</Link> },
                  { id: "number", header: t("accessReview.number"), card: "fact", cell: g => g.account_employee_number ?? "—" },
                  { id: "role", header: t("accessReview.role"), card: "fact", cell: g => g.role_name_ko },
                  { id: "scope", header: t("accessReview.scope"), card: "fact", cell: g => storedScope(g.scope) },
                  { id: "period", header: t("accessReview.period"), card: "fact", cell: g => periodText(g) },
                  { id: "state", header: t("accessReview.state"), card: "status", cell: g => <Chip tone={g.enforcement === "ENFORCED" ? "ok" : "neutral"}>{enforcementText(g.enforcement)}</Chip> },
                ]} />
            </>}
      </Card>}</QueryState>
      {selected && <AccessReviewDetailSheet grant={selected} onClose={() => setSelected(null)} />}
    </div>
  );

  return (
    <AccessReviewConsole
      grants={grants}
      phase={phase}
      items={items}
      rows={rows}
      find={find}
      onFind={setFind}
      statItems={statItems}
      selected={selected}
      onSelect={setSelected}
      baseline={renderBaseline}
    />
  );
}
