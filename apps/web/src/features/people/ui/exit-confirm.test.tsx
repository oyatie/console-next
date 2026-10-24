// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { Button } from "../../../ui/button/button";
import { commitLabel } from "../../../ui/composer/actions";
import type { StepFrame } from "./exit-foot";
import { ConfirmForm } from "./exit-confirm";

vi.mock("../../../lib/pure/today", () => ({ todayKst: () => "2026-10-24" }));
vi.mock("./use-exit-command", () => ({ useExitCommand: () => ({ locked: false }) }));
vi.mock("./exit-foot", () => ({ StepFrame: (p: ComponentProps<typeof StepFrame>) => <>{p.consequence}<Button>{commitLabel(p.action)}</Button></> }));
vi.mock("../../../lib/reason-codes", () => ({ useExitClass: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each([
  ["2026-10-24", "2026. 10. 25.", true],
  ["2026-10-23", "2026. 10. 24.", false],
  ["2026-10-26", "2026. 10. 27.", true],
])("HR confirmation for last working day %s uses the derived retirement date", (last, date, scheduled) => {
  const c = { id: last, employee_id: "person", employee_name: "경계직원", effective_exit_date: last, protected_periods: [] } as unknown as ComponentProps<typeof ConfirmForm>["c"];
  const html = renderToStaticMarkup(<ConfirmForm c={c} hq={false} onDone={() => {}} />);
  expect(html).toContain(`${date}자로 퇴직 처리${scheduled ? "하도록 예약합니다" : "합니다"}`);
  expect(html).toContain(scheduled ? "퇴직 1명 예약" : "퇴직 1명 반영");
});
