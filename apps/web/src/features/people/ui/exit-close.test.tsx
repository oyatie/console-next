// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { CloseForm } from "./exit-close";

vi.mock("./use-exit-command", () => ({ useExitCommand: () => ({ phase: { kind: "idle" } }) }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ refetch: vi.fn() }) }));
vi.mock("../../../ui/sheet/sheet", () => ({ Sheet: ({ consequence, notice, actions, children }: { consequence: ReactNode; notice: ReactNode; actions: ReactNode; children: ReactNode }) => <>{consequence}{notice}{actions}{children}</> }));
beforeAll(() => loadCatalog("ko"));

const c = (state: "APPLIED" | "SCHEDULED") => ({
  id: "case", employee_id: "employee", employee_name: "퇴직자", status: "HR_CONFIRMED",
  effective_exit_date: "2026-10-10", exit_event_state: state,
}) as components["schemas"]["EmployeeExitCase"];
const render = (state: "APPLIED" | "SCHEDULED", reject: boolean) =>
  renderToStaticMarkup(<CloseForm c={c(state)} reject={reject} onClose={() => {}} onDone={() => {}} />);

test.each(["APPLIED", "SCHEDULED"] as const)("a stale cancel sheet never promises to reverse a %s exit", (state) => {
  const html = render(state, false);
  expect(html).toContain(t("exit.unavailable"));
  expect(html).not.toContain('type="submit"');
  expect(html).not.toContain("취소 사유");
  expect(html).not.toContain(t("exit.close.consequence", { name: "퇴직자" }));
  expect(html).not.toContain("퇴직 전 상태로 복원");
  expect(html).not.toContain("퇴직 예약을 거둡니다");
});

test("the cancellation refusal directs the user to the existing reasoned rejection", () => {
  expect(t("exit.error.exit_cancel_after_hr_confirmation")).toBe("인사 확인 뒤에는 퇴직 보고를 취소할 수 없습니다. 사유를 남겨 반려하십시오.");
});

test("rejection explains the compensating event and requires a reason", () => {
  const html = render("APPLIED", true);
  expect(html).toContain("퇴직 전 상태로 복원");
  expect(html).toContain("반려 사유");
  expect(html).toContain('required=""');
});
