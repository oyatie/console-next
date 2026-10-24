// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { loadCatalog } from "@console/i18n";
import { CardHead } from "./card-head";
import { SecLeave } from "./sec-contract-leave";
import type { Card } from "./use-card";

vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: { items: [] } }) }));
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <span>{children}</span>, useNavigate: () => vi.fn() }));
vi.mock("./use-case-actions", () => ({ useOwnRecord: () => false }));
vi.mock("./employee-warnings", () => ({ EmployeeWarnings: () => null }));
vi.mock("../ExitCase", () => ({ ExitCases: () => null }));
beforeAll(() => loadCatalog("ko"));

const card = (status: Card["e"]["status"], planned = false): Card => ({
  e: { id: "employee", name: "경계직원", status, exit_date: "2026-10-31" },
  d: { classification: {} }, personal: {}, events: { data: { items: [] } },
  place: { entity: "법인", path: [] }, title: () => undefined,
  planned: planned ? { event_type: "TERMINATE", effective_date: "2026-10-31" } : undefined,
}) as unknown as Card;
const head = (c: Card) => renderToStaticMarkup(<CardHead c={c} onTab={() => {}} onAct={() => {}} onGo={() => {}} onKeys={() => {}} />);

test("the exited card head shows the first non-employed date", () => {
  expect(head(card("EXITED"))).toContain("2026. 11. 01.에 퇴직했습니다");
});

test("the leave section shows the same first non-employed date", () => {
  const leave = renderToStaticMarkup(<SecLeave c={card("EXITED")} />);
  expect(leave).toContain("2026. 11. 01. 퇴직");
  expect(leave).not.toContain("2026. 10. 31.");
});

test.each([true, false])("the next exit agrees with the exit panel (history available: %s)", (planned) => {
  const c = card("ACTIVE", planned);
  c.e.next_event = { id: "exit", event_type: "TERMINATE", effective_date: "2026-10-31" } as Card["e"]["next_event"];
  expect(head(c)).toContain("2026. 11. 01. 퇴직 예정");
  expect(head(c)).not.toContain("2026. 10. 31.");
});
