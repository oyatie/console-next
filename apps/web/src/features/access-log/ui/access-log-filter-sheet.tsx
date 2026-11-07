// SPDX-License-Identifier: LicenseRef-Proprietary
import { useInfiniteQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { EmptyState } from "../../../ui/empty-state";
import { Sheet } from "../../../ui/sheet/sheet";
import { accessLogPages, type AccessLogFilters } from "../api";
import { AccessLogFiltersForm } from "./access-log-filters";

export function AccessLogFilterSheet({ period, value, onClose, onApply }: {
  period?: string;
  value: AccessLogFilters;
  onClose: () => void;
  onApply: (filters: AccessLogFilters) => void;
}) {
  // Read choices without the refused filters; the server still authorizes this read.
  const q = useInfiniteQuery(accessLogPages(period, false));
  return <Sheet open title={t("accessLog.filters")} onClose={onClose} consequence={null} actions={null}>
    <QueryState q={q} layout="form">{data => {
      const source = data.pages[0]!;
      return source.filter_options
        ? <AccessLogFiltersForm value={value} options={source.filter_options} period={source.period} onApply={onApply} />
        : <EmptyState title={t("accessLog.filtersUnavailable")} reason={t("accessLog.filtersUnavailableReason")} />;
    }}</QueryState>
  </Sheet>;
}
