// SPDX-License-Identifier: LicenseRef-Proprietary
/* oxlint-disable react/jsx-no-literals -- Browser-only component fixture. */
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider, useRouterState } from "@tanstack/react-router";
import { loadCatalog, t } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { Table } from "../../../ui/table";
import { at, type Range } from "../../../ui/sheet-grid/range";
import type { GridRow } from "../api";
import { MonthGridView } from "./month-grid-view";
import { useDrafts } from "./use-drafts";
import "../../../app.css";

await loadCatalog();
const query = new URLSearchParams(location.search);
const DAYS = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, "0")}`);
// `?unscheduled` gives the first person a day without a schedule, which adds the month view's third lead column and its assign button.
const unscheduled = query.has("unscheduled");
// `?style=console` draws the view as the console month screen calls it, with that screen's open-exceptions list below.
const inConsole = query.get("style") === "console";
const ROWS: GridRow[] = Array.from({ length: 12 }, (_, r) => ({
  employee_id: `00000000-0000-4000-8000-${String(r + 1).padStart(12, "0")}`,
  employee_number: String(1001 + r),
  name: `Person ${r + 1}`,
  unit_name: "Unit",
  own: false,
  month_state: { state: "OPEN" },
  cells: DAYS.map((date, c) => ({
    date, plan_kind: unscheduled && r === 0 && c === 0 ? "NO_SCHEDULE" : "WORK", recognised: 0, unrecognised: 0, not_worked: 0,
    // One saved day, so Delete has something to ask about. In the console look it also changes how the first row is drawn,
    // and the sideways case at 640 px finds a day cut at the box's edge only in that layout.
    ...(r === 0 && c === 1 ? { entry_id: "00000000-0000-4000-8000-00000000e001", entry_kind: "TIMES" as const, recognised: 480 } : {}),
  })),
  totals: { recognised: 9600, approved: 90, unrecognised: 30, not_worked: 0, blocking: 2, decision: 1 },
}));
const FOOTER = [{ key: "worked", label: "Worked", day: () => ROWS.length, tail: ["1600:00", "15:00", "5:00", "36"] }];
const ISSUES = ROWS.slice(0, 3).map((row) => ({ key: row.employee_id, name: row.name }));

/** The month view over real drafts, on the route its name links start from. The loading page sizes `main`. */
export function Fixture() {
  const store = useDrafts("2026-10::", ROWS);
  const [range, setRange] = useState<Range | null>(null);
  const [acts, setActs] = useState<string[]>([]);
  const search = useRouterState({ select: (s) => s.location.searchStr });
  const look = inConsole ? { consoleOrder: true, tailGroupHeader: t("attendance.monthConsole.grid.tailGroup"), footerRows: FOOTER } : {};
  return (
    <>
      <main>
        <MonthGridView rows={ROWS} total={ROWS.length} days={DAYS} store={store} range={range} onRange={setRange} act={(a) => setActs((was) => [...was, a.kind])} {...look} />
      </main>
      <Button>Outside</Button>
      {/* As the save panel's go-to does: a cell selected from outside the grid. */}
      <Button onClick={() => setRange(at(ROWS[2]!.employee_id, DAYS[27]!))}>Go to</Button>
      {inConsole && <Table label={t("attendance.monthConsole.bottom.issuesTitle")} rows={ISSUES} rowId={(i) => i.key} onSelect={() => undefined} columns={[{ header: "Name", cell: (i) => i.name }]} />}
      <output id="drafts">{JSON.stringify(Object.fromEntries(Object.entries(store.drafts).map(([key, d]) => [key.slice(-15), d.value])))}</output>
      <output id="acts">{acts.join(",")}</output>
      <output id="search">{search}</output>
    </>
  );
}

const root = createRootRoute();
const router = createRouter({
  routeTree: root.addChildren([createRoute({ getParentRoute: () => root, path: "/attendance", component: Fixture })]),
  history: createMemoryHistory({ initialEntries: ["/attendance"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
