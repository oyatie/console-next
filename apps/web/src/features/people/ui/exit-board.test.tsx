// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { exitLeg, exitLegAtRisk } from "../domain/exit-legs";
import { exitTrail } from "../../../../../../e2e/mock/people-exits";

vi.mock("../../../lib/react/command", () => ({ useCommand: () => ({ isPending: false, error: null, mutate: vi.fn() }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
beforeAll(() => loadCatalog("ko"));
const exitItem = (overrides: Partial<ReturnType<typeof exitTrail>["items"][number]> = {}) => ({ ...exitTrail().items[0]!, ...overrides });
const renderBoard = async (value = exitTrail(), dueSoonDays = 7) => {
  const { ExitBoard } = await import("./exit-board");
  return renderToStaticMarkup(<ExitBoard value={value} lastWorkingDay="2026-10-26" dueSoonDays={dueSoonDays} />);
};

test.each([["DOC", "documents"], ["FIL", "filing"], ["PAY", "settlement"], ["ACC", "access"], ["BACK", "access"], ["FUTURE", "documents"]])("%s maps its trailGroup to %s", (kind, leg) => {
  expect(exitLeg(exitItem({ kind, item_key: "future-key" }))).toBe(leg);
  expect(exitLeg(exitItem({ kind, item_key: "__proto__" }))).toBe(leg);
});
test.each([["X1", "approval"], ["X18", "handover"], ["X5", "settlement"], ["X8", "settlement"], ["X14", "settlement"], ["X15", "settlement"]])("register item %s belongs to %s", (item_key, leg) => {
  expect(exitLeg(exitItem({ item_key, basis: { exit_leg: leg } }))).toBe(leg);
});
test("only unfinished, verified, non-payroll deadlines inside the configured window flag a leg", () => {
  expect(exitLegAtRisk([exitItem()], 3)).toBe(true);
  expect(exitLegAtRisk([exitItem({ due_in_days: -2 })], 3)).toBe(true);
  for (const patch of [{ due_in_days: 4 }, { due_in_days: null }, { due_date: null }, { due_disposition: "UNKNOWN" }, { due_disposition: "HOLD" }, { status: "DONE_ATTESTED" }, { status: "NOT_APPLICABLE" }, { basis: { payroll_pending: true } }, { status_code: "LEGAL_REVIEW" }]) {
    expect(exitLegAtRisk([exitItem(patch)], 3)).toBe(false);
  }
});
test("six named legs and a dated ribbon retain every record without guessed dates or payroll urgency", async () => {
  const html = await renderBoard();
  for (const name of ["결재", "인수인계", "정산·급여", "접근·장비", "서류", "법정 신고", "사건 일정"]) expect(html).toContain(`aria-label="${name}"`);
  expect(html).toContain("오늘");
  expect(html).toContain("2026. 10. 27.");
  expect(html).toContain("D-3");
  expect(html.match(/급여 연동 전/g)).toHaveLength(3);
  expect(html).not.toContain("D+9");
  expect(html).not.toContain("2099");
});

test("payroll integration placeholders retain recorded documents and their completion path", async () => {
  const value = exitTrail();
  value.items = [exitItem({ item_key: "X8", basis: { exit_leg: "settlement", payroll_pending: true }, observed_ref: { document: { name: "기존 급여 증빙", url: "https://files.example/payroll.pdf" } } })];
  const html = await renderBoard(value);
  expect(html).toContain("급여 연동 전");
  expect(html).toContain('href="https://files.example/payroll.pdf"');
  expect(html).not.toContain("D-3");
});

test("a dated register item keeps its countdown when it has no separate rule reference", async () => {
  const value = exitTrail();
  value.items = [exitItem({ due_rule_ref: null, opens_rule_ref: null })];
  expect(await renderBoard(value)).toContain("D-3");
});

test("P1-1 every board card is a list item, without timeline rows in the trail region", async () => {
  const html = await renderBoard();
  expect(html.match(/<ul /g)).toHaveLength(6);
  for (const item of exitTrail().items) expect(html).toContain(`<li id="item-${item.id}"`);
  expect(html.indexOf("<ol ")).toBeLessThan(html.indexOf('aria-label="서류 · 법정 기한 · 할 일"'));
});

test.each(["X8", "X14", "X15"])("P1-2 blocking payroll item %s keeps its legal date and real completion action", async (item_key) => {
  const value = exitTrail();
  value.items = [value.items.find(item => item.item_key === item_key)!];
  const html = await renderBoard(value);
  expect(html).toContain('dateTime="2026-11-09"');
  expect(html).toContain("증빙 확인 완료");
  expect(html).not.toContain("D+9");
});

test("P1-3 the configured window controls both the header and shared deadline tone", async () => {
  const value = exitTrail();
  value.items = [exitItem({ due_in_days: 10 })];
  expect(exitLegAtRisk(value.items, 12)).toBe(true);
  expect(exitLegAtRisk(value.items, 2)).toBe(false);
  expect(await renderBoard(value, 12)).toContain("기한 임박");
  const far = await renderBoard(value, 2);
  expect(far).not.toContain("기한 임박");
  expect(far).toMatch(/class="chip [^"]*far[^"]*"/);
});

test("register metadata works with arbitrary item keys and invalid metadata falls back to the trail group", () => {
  expect(exitLeg(exitItem({ item_key: "register-renamed", basis: { exit_leg: "handover" } }))).toBe("handover");
  for (const exit_leg of ["future-leg", "__proto__", null]) expect(exitLeg(exitItem({ kind: "FUTURE", basis: { exit_leg } }))).toBe("documents");
});

test("missing settings flag only overdue legs and never invent a due-soon window", () => {
  expect(exitLegAtRisk([exitItem()], null)).toBe(false);
  expect(exitLegAtRisk([exitItem({ due_in_days: -1 })], null)).toBe(true);
  expect(exitLegAtRisk([exitItem({ basis: { legal_review_required: true } })], 12)).toBe(false);
});
