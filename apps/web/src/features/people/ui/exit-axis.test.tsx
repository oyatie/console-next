// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { CaseAxis } from "./exit-axis";

vi.mock("./use-case-actions", () => ({ useCaseActions: () => ({ next: null, forward: null, back: [], sameActor: false }) }));
vi.mock("./exit-confirm", () => ({ ConfirmForm: () => null }));
vi.mock("./exit-settlement", () => ({ SettlementForm: () => null }));
beforeAll(() => loadCatalog("ko"));

test("the timeline dates reported and scheduled retirement from the day after the last working day", () => {
  const c = { id: "case", status: "HR_CONFIRMED", employee_name: "경계직원", effective_exit_date: "2026-10-24", exit_event_state: "SCHEDULED", reported_by_name: "인사담당자", hr_confirmed_by_name: "인사담당자", hr_confirmed_at: "2026-10-24T01:00:00Z" } as ComponentProps<typeof CaseAxis>["c"];
  const html = renderToStaticMarkup(<CaseAxis c={c} onBack={() => {}} onDone={() => {}} />);
  expect(html).toContain("2026. 10. 25.자 퇴직을 보고했습니다");
  expect(html).toContain("퇴직을 2026. 10. 25.자로 예약했습니다");
  expect(html).not.toContain("2026. 10. 24.자로 예약했습니다");
});
