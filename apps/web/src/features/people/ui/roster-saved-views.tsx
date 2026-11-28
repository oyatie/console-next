// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { EmployeeViewFilters } from "@console/api/pending";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { employeeViewsQuery } from "../api/roster";

const SavedViews = lazy(() => chunk(import("./roster-saved-content")).then(m => ({ default: m.SavedViews })));

/** `unavailable`: the roster's own read failed; the page says so once, and the views wait for the list they filter. */
export function RosterSavedViews({ filters, onApply, unavailable = false }: { filters: EmployeeViewFilters; onApply: (filters: EmployeeViewFilters) => void; unavailable?: boolean }) {
  const [open, setOpen] = useState(false);
  const list = useQuery(employeeViewsQuery);
  const showEditor = open && !unavailable && list.data !== undefined && !list.isError;
  return <>
    <Button aria-haspopup="dialog" aria-expanded={showEditor} disabled={unavailable || !list.data || list.isError} onClick={() => setOpen(true)}>{t("directoryViews.open")}</Button>
    {list.isError && !unavailable && <QueryState q={list} inline>{() => null}</QueryState>}
    {showEditor && <Suspense fallback={null}><SavedViews list={list} filters={filters} onApply={value => { onApply(value); setOpen(false); }} onClose={() => setOpen(false)} /></Suspense>}
  </>;
}
