// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import type { GridRow } from "../api";
import { MonthGridView } from "./month-grid-view";
import type { useDrafts } from "./use-drafts";

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
beforeAll(() => loadCatalog("ko"));

test("zero-hour totals render as dashes", () => {
  const row: GridRow = {
    employee_id: "00000000-0000-0000-0000-000000000001", name: "Person", own: false, month_state: { state: "OPEN" },
    cells: [{ date: "2026-10-01", plan_kind: "WORK", recognised: 0, unrecognised: 0, not_worked: 0 }],
    totals: { recognised: 0, approved: 0, unrecognised: 0, not_worked: 0, blocking: 0, decision: 0 },
  };
  const store = { scope: "2026-10", drafts: {}, set: vi.fn(), put: vi.fn(), keep: vi.fn(), undo: vi.fn(), redo: vi.fn() } as unknown as ReturnType<typeof useDrafts>;
  const html = renderToStaticMarkup(<MonthGridView rows={[row]} total={1} days={["2026-10-01"]} store={store} range={null} onRange={() => {}} act={() => {}} />);
  expect(html).not.toContain(">0:00<");
  expect(html.match(/<td[^>]*>–<\/td>/g)).toHaveLength(4);
  const nonzero = renderToStaticMarkup(<MonthGridView rows={[{ ...row, totals: { ...row.totals, recognised: 480 } }]} total={1} days={["2026-10-01"]} store={store} range={null} onRange={() => {}} act={() => {}} />);
  expect(nonzero).toContain(">8:00<");
  expect(nonzero.match(/<td[^>]*>–<\/td>/g)).toHaveLength(3);
});
