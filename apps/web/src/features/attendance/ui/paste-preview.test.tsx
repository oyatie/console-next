// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import type { ReactNode } from "react";
import { loadCatalog } from "@console/i18n";
import type { PasteResult } from "../domain/grid";
import { PastePreviewSheet, type PastePerson } from "./paste-preview";

type SheetProps = { open: boolean; title: string; notice?: ReactNode; consequence: ReactNode; actions: ReactNode; children: ReactNode };
vi.mock("../../../ui/sheet/sheet", () => ({
  Sheet: (p: SheetProps) => p.open ? <section><h2>{p.title}</h2>{p.children}{p.notice}<p>{p.consequence}</p>{p.actions}</section> : null,
}));
beforeAll(() => loadCatalog("ko"));

const people: PastePerson[] = [{ employee_id: "employee-1", employee_number: "20007", name: "홍길동", own: false, closed: false }];
const preview: PasteResult = {
  cells: [{ r: 0, c: 0, date: "2026-10-01", value: "09:00-18:00" }],
  identities: [{ r: 0, name: "홍길동", department: "인사" }],
  matched: 1,
  missing: ["99999"],
  ignoredColumns: ["근무일수", "연장"],
  refusal: null,
};
const render = (plan: PasteResult, reviewers: PastePerson[] = people) => renderToStaticMarkup(<PastePreviewSheet plan={plan} people={reviewers} month="2026-10" onClose={() => undefined} onAccept={() => undefined} />);

test("the attendance paste sheet shows destinations, ignored input, and an explicit accept action", () => {
  const html = render(preview);
  expect(html).toContain("붙여넣기 미리보기");
  expect(html).toContain("10-01");
  expect(html).toContain("09:00-18:00");
  expect(html).toContain("근무일수 · 연장");
  expect(html).toContain("99999");
  expect(html).toContain("초안에 1칸 반영");
  expect(html).not.toContain('role="alert"');
});

test("a refused paste explains the issue and exposes no accept action", () => {
  const html = render({ ...preview, refusal: "unlabelledMultiRow" });
  expect(html).toContain('<p role="alert">');
  expect(html).toContain("한 직원이 여러 행에 있습니다");
  expect(html).not.toMatch(/<button[^>]*>[^<]*초안에/);
});

test("a closed-month row is shown as locked and cannot be accepted", () => {
  const html = render(preview, [{ ...people[0]!, closed: true }]);
  expect(html).toContain("잠김 · 반영 안 함");
  expect(html).not.toContain("초안에 1칸 반영");
});
