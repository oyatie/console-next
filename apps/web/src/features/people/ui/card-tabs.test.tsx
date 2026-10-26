// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog } from "@console/i18n";
import type { LifecycleEvent } from "../api";
import { LEGACY_SYSTEM_COMMENTS, commentText, describeEvent } from "../present";
import type { Card } from "./use-card";
import { CardTabs } from "./card-tabs";
import { PersonHistory } from "./person-history";
import { PrintPaper } from "./print-paper";

beforeAll(() => loadCatalog("ko"));

const makeEvent = (overrides: Partial<LifecycleEvent>): LifecycleEvent =>
  ({
    id: "ev-1",
    employee_id: "emp-1",
    event_type: "ONBOARD",
    to_status: "ACTIVE",
    state: "APPLIED",
    effective_date: "2026-10-15",
    comment: "Created through People & Workforce",
    signoffs: {},
    created_by: "u-1",
    created_by_name: "김인사",
    created_at: "2026-10-15T00:00:00Z",
    ...overrides,
  }) as LifecycleEvent;

const makeCard = (events: LifecycleEvent[]): Card =>
  ({
    d: {
      employee: {
        id: "emp-1",
        name: "정하늘",
        hire_date: "2026-10-15",
        status: "ACTIVE",
      },
      classification: {},
      employment: { employment_type: "REGULAR" },
    },
    e: {
      id: "emp-1",
      name: "정하늘",
      hire_date: "2026-10-15",
      status: "ACTIVE",
    },
    manage: true,
    request: false,
    users: false,
    events: { data: { items: events } },
    personal: { data: undefined },
    register: { data: undefined },
    facts: { data: undefined },
    records: { data: { items: [] } },
    planned: undefined,
    title: () => undefined,
    setup: false,
    place: { entity: "주식회사 가나", workplace: "본사", path: [] },
  }) as unknown as Card;

test.each([{ comment: "Created through People & Workforce" }, { comment: "", comment_code: "created_by_registration" }])("system comment %# uses one presenter in ledger, print and timeline", (system) => {
  const cCreated = makeCard([makeEvent({ event_type: "ONBOARD", ...system })]);
  const createdLedger = renderToStaticMarkup(
    <CardTabs c={cCreated} tab="ledger" verbs={[]} today="2026-10-15" done={null} onAct={() => {}} onDismiss={() => {}} />,
  );
  const ledgerCells = [...createdLedger.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)];
  expect(ledgerCells).toHaveLength(9);
  expect(ledgerCells[7]?.[1]).toBe("직원 등록");
  expect(createdLedger).toContain("직원 등록");
  expect(createdLedger).not.toContain("Created through People & Workforce");
  expect(createdLedger).not.toContain("Created through People &amp; Workforce");

  const createdPrint = renderToStaticMarkup(
    <PrintPaper c={cCreated} parts={["events"]} at="2026-10-15T09:00:00Z" />,
  );
  expect(createdPrint).toContain("직원 등록");
  expect(createdPrint).not.toContain("Created through People & Workforce");
  expect(createdPrint).not.toContain("Created through People &amp; Workforce");
  const timeline = renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><PersonHistory employee={cCreated.e} events={cCreated.events} verbs={[]} manage={false} today="2026-10-15" done={null} onAct={() => {}} onDismiss={() => {}} /></QueryClientProvider>);
  expect(timeline).toContain("직원 등록");
  expect(timeline).not.toContain("Created through");
});

test("a user-written English comment on a TRANSFER event still renders verbatim in describeEvent, CardTabs ledger, and PrintPaper", () => {
  const ev = makeEvent({
    event_type: "TRANSFER",
    comment: "transferred per request",
    from_org_unit: "인사부",
    to_org_unit: "채용팀",
  });
  expect(describeEvent(ev, "정하늘").detail).toContain("transferred per request");

  const c = makeCard([ev]);
  const ledgerHtml = renderToStaticMarkup(
    <CardTabs c={c} tab="ledger" verbs={[]} today="2026-10-15" done={null} onAct={() => {}} onDismiss={() => {}} />,
  );
  expect(ledgerHtml).toContain("transferred per request");

  const evNoUnits = makeEvent({
    event_type: "TRANSFER",
    comment: "transferred per request",
  });
  const printHtml = renderToStaticMarkup(
    <PrintPaper c={makeCard([evNoUnits])} parts={["events"]} at="2026-10-15T09:00:00Z" />,
  );
  expect(printHtml).toContain("transferred per request");
});

test("the legacy system-sentence alias list can only shrink and arbitrary notes stay as written", () => {
  expect(Object.entries(LEGACY_SYSTEM_COMMENTS)).toEqual([["Created through People & Workforce", "created_by_registration"]]);
  expect(commentText("Created through another service")).toBe("Created through another service");
  expect(commentText("사용자 메모", "future_code")).toBe("사용자 메모");
});
