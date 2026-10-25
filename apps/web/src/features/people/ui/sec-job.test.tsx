// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { SecJob } from "./sec-job";
import type { Card } from "./use-card";

vi.mock("./employment-placement", () => ({ EmploymentPlacement: () => null }));
vi.mock("./employment-record", () => ({ EmploymentRecord: () => null }));
vi.mock("./home-branch-card", () => ({ HomeBranchCard: () => <span data-legacy-branch>{t("people.field.homeBranch")}</span> }));

beforeAll(() => loadCatalog("ko"));

type Employee = Card["e"] & { status_since?: string | null };
const hireDate = "2020-03-02";
const lastWorkday = "2026-10-22";

function card(employee: Partial<Employee> = {}, manage = false): Card {
  return {
    e: { id: "employee", status: "ACTIVE", hire_date: hireDate, exit_date: lastWorkday, workplace_id: "workplace", ...employee } as Employee,
    d: { classification: {}, employment: { employment_type: "REGULAR" } },
    events: { data: { items: [] } },
    facts: {}, personal: {}, manage,
    title: () => undefined,
    place: { entity: "한빛법인", workplace: "본사", path: ["개발본부", "개발팀"] },
  } as unknown as Card;
}

const render = (c: Card) => renderToStaticMarkup(<SecJob c={c} onFix={() => undefined} onAct={() => undefined} onTab={() => undefined} />);

function field(html: string, label: string) {
  const start = html.indexOf(`>${label}</span>`);
  expect(start, `field ${label} exists`).toBeGreaterThanOrEqual(0);
  return html.slice(start, html.indexOf("</div>", start));
}

function statusRow(status: Employee["status"], status_since?: string) {
  const html = render(card({ status, status_since }));
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

test("the assignment's legal entity, workplace and department stay separate from its physical site", () => {
  const html = render(card({ worksite_name: "고객현장" }, true));
  expect(field(html, t("empCard.f.entity"))).toContain("한빛법인");
  expect(field(html, t("empCard.f.workplace"))).toContain("본사");
  expect(field(html, t("empCard.f.unit"))).toContain("개발본부 › 개발팀");
  expect(field(html, t("import.target.worksite_name"))).toContain("고객현장");
  expect(field(html, t("empCard.f.workplace"))).not.toContain("고객현장");
});

test("a physical-site fallback from the shared hook never makes an unplaced person look placed", () => {
  const c = card({ workplace_id: null, worksite_name: "고객현장" });
  c.place.workplace = "고객현장";
  const html = render(c);
  expect(field(html, t("empCard.f.workplace"))).toContain(t("empCard.unplaced"));
  expect(field(html, t("empCard.f.workplace"))).not.toContain("고객현장");
  expect(field(html, t("import.target.worksite_name"))).toContain("고객현장");
});

test.each([true, false])("the personnel card has no legacy branch assignment control (manage: %s)", (manage) => {
  const html = render(card({ home_branch_id: "legacy", home_branch_name: "소속 지점" }, manage));
  expect(html).not.toContain("data-legacy-branch");
  expect(html).not.toContain("지점");
});

test("an absent optional physical site has no empty field row", () => {
  const html = render(card({ worksite_name: null }));
  expect(html).not.toContain(`>${t("import.target.worksite_name")}</span>`);
});

test("a workplace placement without a department never reads as unplaced", () => {
  const c = card({ org_unit: null, org_unit_id: null });
  c.place.path = [];
  const html = render(c);
  expect(field(html, t("empCard.f.workplace"))).toContain("본사");
  expect(field(html, t("empCard.f.unit"))).toContain("—");
  expect(html).not.toContain(t("empCard.unplaced"));
});
