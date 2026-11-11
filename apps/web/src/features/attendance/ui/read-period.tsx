// SPDX-License-Identifier: LicenseRef-Proprietary
import { getRouteApi } from "@tanstack/react-router";
import { todayKst } from "../../../lib/pure/today";
import { PeriodStepper } from "./period-stepper";
import { ScopePicker } from "./scope-picker";
import s from "./records.module.css";

const route = getRouteApi("/app/attendance");
/** Period and workplace remain usable above the read boundary, including a refused read. */
export function ReadPeriod({ week = false }: { week?: boolean }) {
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const date = search.date ?? todayKst();
  const month = search.month ?? date.slice(0, 7);
  return <div className={s.toolbar}>
    <ScopePicker value={search.wp} onChange={wp => void navigate({ search: s => ({ ...s, wp, unit: undefined }) })} />
    <PeriodStepper unit={week ? "week" : "month"} value={week ? date : month}
      onChange={value => void navigate({ search: s => ({ ...s, ...(week ? { date: value } : { month: value }) }) })} />
  </div>;
}
