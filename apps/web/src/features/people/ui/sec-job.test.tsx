// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { SecJob } from "./sec-job";
import type { Card } from "./use-card";

vi.mock("./employment-placement", () => ({ EmploymentPlacement: () => null }));
vi.mock("./employment-record", () => ({ EmploymentRecord: () => null }));
vi.mock("./home-branch-card", () => ({ HomeBranchCard: () => null }));

beforeAll(() => loadCatalog("ko"));

type Employee = Card["e"] & { status_since?: string | null };
const hireDate = "2020-03-02";
const lastWorkday = "2026-10-22";

function statusRow(status: Employee["status"], status_since?: string) {
  const c = {
    e: { id: "employee", status, status_since, hire_date: hireDate, exit_date: lastWorkday } as Employee,
    d: { classification: {}, employment: { employment_type: "REGULAR" } },
    events: { data: { items: [] } },
    facts: {}, personal: {}, manage: false,
    title: () => undefined,
    place: { entity: "법인", workplace: "사업장", path: [] },
  } as unknown as Card;
  const html = renderToStaticMarkup(<SecJob c={c} onFix={() => undefined} onAct={() => undefined} onTab={() => undefined} />);
  expect(html).not.toContain(t("empCard.f.workForm"));
  expect(html).not.toContain(t("empCard.f.concurrent"));
  return html.slice(html.indexOf(t("empCard.f.status")), html.indexOf(t("empCard.f.entity")));
}

test("leave status begins on the server's status interval, not the hire date", () => {
  const since = "2026-09-15";
  const html = statusRow("ON_LEAVE", since);
  expect(html).toContain(t("enum.employeeStatus.ON_LEAVE"));
  expect(html).toContain(t("empCard.status.since", { date: fmtDate(since) }));
  expect(html).not.toContain(fmtDate(hireDate));
});

test("exited status begins on the server's derived first non-employed day", () => {
  const since = "2026-10-23";
  const html = statusRow("EXITED", since);
  expect(html).toContain(t("enum.employeeStatus.EXITED"));
  expect(html).toContain(t("empCard.status.since", { date: fmtDate(since) }));
  expect(html).not.toContain(fmtDate(lastWorkday));
});

test("active status after a return begins on the server's return date", () => {
  const since = "2026-10-21";
  const html = statusRow("ACTIVE", since);
  expect(html).toContain(t("enum.employeeStatus.ACTIVE"));
  expect(html).toContain(t("empCard.status.since", { date: fmtDate(since) }));
  expect(html).not.toContain(fmtDate(hireDate));
});

test("an older response without status_since shows no guessed status date", () => {
  const html = statusRow("ON_LEAVE");
  expect(html).toContain(t("enum.employeeStatus.ON_LEAVE"));
  expect(html).not.toContain(fmtDate(hireDate));
  expect(html).not.toContain(fmtDate(lastWorkday));
  expect(html).not.toContain("부터");
});
