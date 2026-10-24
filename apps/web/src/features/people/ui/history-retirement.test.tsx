// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps } from "react";
import { loadCatalog } from "@console/i18n";
import { NextBox } from "./person-next";
import { PersonHistory } from "./person-history";
import { CardSpine } from "./card-spine";

vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ q, children }: { q: { data: unknown }; children: (data: unknown) => unknown }) => children(q.data) }));
beforeAll(() => loadCatalog("ko"));

const event = { id: "exit", event_type: "TERMINATE", effective_date: "2026-10-31", state: "SCHEDULED", created_at: "2026-10-01T00:00:00Z", comment: "계약 만료" };

test("the next-record date and D-day agree with the card head and exit panel", () => {
  const d = { employee: { next_event: event, status: "ACTIVE" }, employment: null } as unknown as ComponentProps<typeof NextBox>["d"];
  const html = renderToStaticMarkup(<NextBox d={d} events={[]} verbs={[]} today="2026-10-31" onAct={() => {}} />);
  expect(html).toContain("2026. 11. 01.");
  expect(html).toContain("D-1");
  expect(html).not.toContain("2026. 10. 31.");
});

test("the history ribbon does not mark an exit due on its last working day", () => {
  const props = { employee: { name: "경계직원" }, events: { data: { items: [event] } }, verbs: [], manage: false, today: "2026-10-31", done: null, onAct: () => {}, onDismiss: () => {} } as unknown as ComponentProps<typeof PersonHistory>;
  const html = renderToStaticMarkup(<PersonHistory {...props} />);
  expect(html).toContain("2026. 11. 01.");
  expect(html.match(/2026\. 11\. 01\./g)).toHaveLength(2);
  expect(html).not.toContain("오늘 반영 대기");
});

test("the default card ribbon labels retirement on the same date as the full history", () => {
  const employee = { name: "경계직원", status: "EXITED" };
  const c = { e: employee, d: { employee, classification: {} }, events: { data: { items: [{ ...event, state: "APPLIED" }] }, isSuccess: true }, place: { path: [] }, title: () => undefined } as unknown as ComponentProps<typeof CardSpine>["c"];
  const html = renderToStaticMarkup(<CardSpine c={c} onAct={() => {}} onLedger={() => {}} onHistory={() => {}} />);
  expect(html).toContain("2026. 11. 01.");
  expect(html).not.toContain("2026. 10. 31.");
});
