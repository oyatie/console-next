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
