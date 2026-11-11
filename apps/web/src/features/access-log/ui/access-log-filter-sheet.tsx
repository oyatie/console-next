// SPDX-License-Identifier: LicenseRef-Proprietary
import type { InfiniteData } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import type { ReadState } from "../../../lib/react/query-view";
import { EmptyState } from "../../../ui/empty-state";
import { Sheet } from "../../../ui/sheet/sheet";
import type { AccessLogPage, AccessLogFilters } from "../api";
import { AccessLogFiltersForm } from "./access-log-filters";

export function AccessLogFilterSheet({ source, choices, value, onClose, onApply }: {
  source?: AccessLogPage;
  choices: ReadState<InfiniteData<AccessLogPage>>;
  value: AccessLogFilters;
  onClose: () => void;
  onApply: (filters: AccessLogFilters) => void;
}) {
  const form = (page: AccessLogPage) => page.filter_options
    ? <AccessLogFiltersForm value={value} options={page.filter_options} period={page.period} onApply={onApply} />
    : <EmptyState title={t("accessLog.filtersUnavailable")} reason={t("accessLog.filtersUnavailableReason")} />;
  return <Sheet open title={t("accessLog.filters")} onClose={onClose} consequence={null} actions={null}>
    {source ? form(source) : <QueryState q={choices} layout="form">{data => form(data.pages[0]!)}</QueryState>}
  </Sheet>;
}
