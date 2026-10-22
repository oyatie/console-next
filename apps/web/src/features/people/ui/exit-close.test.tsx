// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { components } from "@console/api/schema";
import { loadCatalog } from "@console/i18n";
import { CloseForm } from "./exit-close";

vi.mock("./use-exit-command", () => ({ useExitCommand: () => ({}) }));
vi.mock("./exit-foot", () => ({ StepFrame: ({ consequence, children }: { consequence: ReactNode; children: ReactNode }) => <>{consequence}{children}</> }));
beforeAll(() => loadCatalog("ko"));

const c = (state: "APPLIED" | "SCHEDULED") => ({
  id: "case", employee_id: "employee", employee_name: "퇴직자", status: "HR_CONFIRMED",
  effective_exit_date: "2026-10-10", exit_event_state: state,
}) as components["schemas"]["EmployeeExitCase"];
const render = (state: "APPLIED" | "SCHEDULED", reject: boolean) =>
  renderToStaticMarkup(<CloseForm c={c(state)} reject={reject} onClose={() => {}} onDone={() => {}} />);

test.each(["APPLIED", "SCHEDULED"] as const)("a stale cancel sheet never promises to reverse a %s exit", (state) => {
  const html = render(state, false);
  expect(html).not.toContain("퇴직 전 상태로 복원");
  expect(html).not.toContain("퇴직 예약을 거둡니다");
});

test("rejection explains the compensating event and requires a reason", () => {
  const html = render("APPLIED", true);
  expect(html).toContain("퇴직 전 상태로 복원");
  expect(html).toContain("반려 사유");
  expect(html).toContain('required=""');
});
