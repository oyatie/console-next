// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import type { JobTitle } from "../domain/titles";
import { appointmentMode } from "../domain/lifecycle";
import { AppointFields } from "./lifecycle-appoint";
import { EMPTY } from "./use-lifecycle-draft";

const catalog = vi.hoisted(() => ({ items: [] as JobTitle[], can_manage: false }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: catalog }) }));

const render = (mode?: "role" | "job") => renderToStaticMarkup(<AppointFields v={EMPTY} set={() => {}} missing={false} mode={mode} />);
beforeAll(() => loadCatalog("ko"));
beforeEach(() => {
  catalog.items = [
    { id: "role", kind: "POSITION", label: "인사팀장", grade_rank: null, active: true },
    { id: "job", kind: "JOB", label: "인사기획", grade_rank: null, active: true },
    { id: "family", kind: "JOB_FAMILY", label: "경영지원", grade_rank: null, active: true },
  ];
});

test("role appointment only changes the role and contains no roadmap hint", () => {
  const html = render();
  expect(html).toContain("인사팀장");
  expect(html).toContain("직책 없음");
  expect(html).not.toContain("인사기획");
  expect(html).not.toContain("경영지원");
  expect(html).not.toContain("겸직");
  expect(html).not.toContain("아직");
  expect(html).not.toContain("설정 ›");
});

test("the separate job action only changes job and family", () => {
  const html = render("job");
  expect(html).toContain("인사기획");
  expect(html).toContain("경영지원");
  expect(html).not.toContain("인사팀장");
  expect(html).not.toContain("직책 없음");
  expect(html).not.toContain("겸직");
});

test("unrelated catalog entries do not open an empty role action", () => {
  catalog.items = catalog.items.filter((x) => x.kind !== "POSITION");
  expect(render("role")).toBe("");
});

test("an unrelated role entry does not open an empty job action", () => {
  catalog.items = catalog.items.filter((x) => x.kind === "POSITION");
  expect(render("job")).toBe("");
});

test("history preserves job-only and legacy mixed appointments", () => {
  expect(appointmentMode("edit:event", { to_job_id: "job" })).toBe("job");
  expect(appointmentMode("correct:event", { to_job_family_id: "family" })).toBe("job");
  expect(appointmentMode("again:event", { to_job_id: "job", to_position_kind_id: "role" })).toBe("all");
  expect(appointmentMode("APPOINT")).toBe("role");
  expect(appointmentMode("APPOINT:job")).toBe("job");
});
