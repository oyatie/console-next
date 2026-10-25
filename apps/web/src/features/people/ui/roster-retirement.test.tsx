// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { loadCatalog } from "@console/i18n";
import { RosterPanel } from "./roster-panel";
import type { Card } from "./use-card";

const state = vi.hoisted(() => ({ card: {} as Card }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: state.card.d }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span>, useNavigate: () => vi.fn() }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ children }: { children: (d: Card["d"]) => ReactNode }) => children(state.card.d) }));
vi.mock("./use-card", () => ({ useCard: () => state.card }));
vi.mock("./use-card-register", () => ({ useCardRegister: () => ({ items: [], gaps: 0, value: () => "" }) }));
vi.mock("./end-actions", () => ({ EndActions: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each([true, false])("the roster peek agrees with the card's next retirement (history available: %s)", (planned) => {
  const exit = { id: "exit", event_type: "TERMINATE", effective_date: "2026-10-31" };
  const employee = { id: "person", name: "경계직원", status: "ACTIVE", next_event: exit };
  state.card = { e: employee, d: { employee, classification: {}, allowed_events: [], allowed_scheduled_events: [] }, planned: planned ? exit : undefined, register: {}, title: () => undefined, place: { path: [] } } as unknown as Card;
  const html = renderToStaticMarkup(<RosterPanel id="person" today="2026-10-31" onClose={() => {}} />);
  expect(html).toContain("2026. 11. 01. 퇴직 예정");
  expect(html).not.toContain("2026. 10. 31.");
});

function peek(workplace: string | null, worksite: string | null) {
  const employee = { id: "person", name: "배치직원", status: "ACTIVE", workplace_id: workplace, worksite_name: worksite, home_branch_name: "폐지 지점", home_branch_review_required: true };
  state.card = { e: employee, d: { employee, classification: {}, allowed_events: [], allowed_scheduled_events: [] }, register: {}, title: () => undefined, place: { entity: "가나다 법인", workplace: "본사", path: ["개발본부"] } } as unknown as Card;
  return renderToStaticMarkup(<RosterPanel id="person" today="2026-10-25" onClose={() => {}} />);
}

test("peek shows the assignment path and physical worksite separately without a branch", () => {
  const html = peek("workplace", "고객 업무공간");
  expect(html).toContain("가나다 법인 › 본사 › 개발본부");
  expect(html).toMatch(/<dt[^>]*>근무지<\/dt><dd>고객 업무공간<\/dd>/);
  expect(html).not.toContain("지점");
  expect(html).not.toMatch(/<(?:input|select)\b|role="(?:radio|combobox)"/);
});

test("a worksite named like a workplace never makes an unplaced person appear placed", () => {
  const html = peek(null, "본사");
  expect(html).toContain("가나다 법인 › 미배치");
  expect(html).not.toContain("가나다 법인 › 본사");
  expect(html).not.toContain("개발본부");
  expect(html).toMatch(/<dt[^>]*>근무지<\/dt><dd>본사<\/dd>/);
  expect(html).not.toContain("지점");
});

test("an absent physical worksite adds no empty row", () => {
  const html = peek("workplace", null);
  expect(html).not.toMatch(/<dt[^>]*>근무지<\/dt>/);
  expect(html).not.toContain("지점");
});
