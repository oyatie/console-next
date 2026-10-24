// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import type { LifecycleEvent } from "../api";
import { PrintPaper } from "./print-paper";
import type { Card } from "./use-card";

vi.mock("../../../lib/pure/today", () => ({ todayKst: () => "2026-10-23" }));
beforeAll(() => loadCatalog("ko"));

test.each([
  ["TERMINATE", "APPLIED", "2026. 11. 01.", "퇴직"],
  ["TERMINATE", "SCHEDULED", "2026. 11. 01.", "퇴직 (예정)"],
  ["OFFBOARD", "APPLIED", "2026. 11. 01.", "OFFBOARD"],
  ["TRANSFER", "APPLIED", "2026. 10. 31.", "전보"],
  ["LEAVE_OF_ABSENCE", "APPLIED", "2026. 10. 31.", "휴직"],
] as const)("printed %s (%s) uses its actual application date", (event_type, state, date, action) => {
  const event = { id: "event", event_type, state, effective_date: "2026-10-31" } as LifecycleEvent;
  const c = {
    e: { id: "person", name: "경계직원", hire_date: "2020-01-02" },
    d: { classification: {} }, place: { entity: "법인", path: [] }, title: () => undefined,
    events: { data: { items: [event] } }, register: {}, personal: {}, facts: {}, records: {},
  } as unknown as Card;
  const html = renderToStaticMarkup(<PrintPaper c={c} parts={["events"]} why={null} at="2026-10-23T00:00:00Z" />);
  expect(html).toContain("적용일");
  expect(html).toContain(`<td>${date}</td><td>${action}</td>`);
  if (event_type === "TERMINATE" || event_type === "OFFBOARD") expect(html).not.toContain("2026. 10. 31.");
});
