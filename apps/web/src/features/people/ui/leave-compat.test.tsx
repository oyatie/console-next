// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog } from "@console/i18n";
import type { LifecycleEvent, Notice } from "../api";
import type { Card } from "./use-card";
import { PersonHistory } from "./person-history";
import { CardSpine } from "./card-spine";
import { CardTabs } from "./card-tabs";
import { PrintPaper } from "./print-paper";
import { SecLeave } from "./sec-contract-leave";
import { ProtectedPeriods } from "./exit-protection";
import { LeaveFields } from "./lifecycle-leave";
import { LifecycleWhat } from "./lifecycle-what";
import { NoticePage } from "./notice-page";

const reads = vi.hoisted(() => ({ notice: undefined as unknown }));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: reads.notice, isSuccess: true }) }));
vi.mock("@tanstack/react-router", () => ({ getRouteApi: () => ({ useParams: () => ({ noticeId: "notice-1" }) }), Link: ({ children }: { children: ReactNode }) => <span>{children}</span> }));
vi.mock("../../../lib/react/query-state", () => ({ QueryState: ({ q, children }: { q: { data: unknown }; children: (data: unknown) => ReactNode }) => children(q.data) }));
vi.mock("../../../lib/react/outcome-link", () => ({ OutcomeLink: () => null }));
vi.mock("./history-verbs", () => ({ rowVerbs: () => null }));
vi.mock("./person-next", () => ({ NextBox: () => null }));
vi.mock("./exit-block", () => ({ ExitCases: () => null }));
vi.mock("./account-link-card", () => ({ AccountLinkCard: () => null }));
vi.mock("./contracts-card", () => ({ ContractsCard: () => null }));
vi.mock("./use-card-register", () => ({ useCardRegister: () => ({ items: [] }) }));
vi.mock("./use-transfer-options", () => ({ useTransferOptions: () => ({}) }));

beforeAll(() => loadCatalog("ko"));
const noop = () => {};
const event = { id: "event-1", employee_id: "person-1", event_type: "LEAVE_OF_ABSENCE", leave_type: "FUTURE_LEAVE", state: "APPLIED", effective_date: "2026-10-01", created_at: "2026-10-01T00:00:00Z", created_by_name: "Synthetic recorder", comment: "", to_status: "ON_LEAVE", signoffs: {} } as LifecycleEvent;
const events = { data: { items: [event], head_version: 1 }, isSuccess: true };
const employee = { id: "person-1", name: "Synthetic employee", status: "ON_LEAVE" };
const c = { e: employee, d: { employee, classification: {} }, events, place: { path: [] }, title: () => undefined, register: {}, personal: {}, records: {}, facts: {} } as unknown as Card;
const notice = (leaveType: string) => ({ notice_no: "N-1", notice_date: "2026-10-23", issued_at: "2026-10-23T00:00:00Z", title: "Synthetic notice", items: [], lines: [{ line_no: 1, name: employee.name, event: { ...event, leave_type: leaveType } }] }) as unknown as Notice;

test("appointment notices retain their existing omission of known leave reasons", () => {
  reads.notice = notice("WORK_INJURY");
  const html = renderToStaticMarkup(<NoticePage />);
  expect(html).not.toContain("산재 요양");
  expect(html).not.toContain("WORK_INJURY");
});

test.each([
  ["history", () => <PersonHistory employee={c.e} events={c.events} verbs={[]} manage={false} today="2026-10-23" done={null} onAct={noop} onDismiss={noop} />],
  ["spine", () => <CardSpine c={c} onAct={noop} onLedger={noop} onHistory={noop} />],
  ["ledger", () => <CardTabs c={c} tab="ledger" verbs={[]} today="2026-10-23" done={null} onAct={noop} onDismiss={noop} />],
  ["printed history", () => <PrintPaper c={c} parts={["events"]} why={null} at="2026-10-23T00:00:00Z" />],
  ["leave periods", () => <SecLeave c={c} />],
  ["protected periods", () => <ProtectedPeriods periods={[{ lifecycle_event_id: event.id, leave_type: event.leave_type!, leave_from: event.effective_date, leave_until: null, protected_until: null, instrument: null, article: null }]} />],
  ["leave correction", () => <LeaveFields start="2026-10-01" today="2026-10-23" type={event.leave_type!} onType={noop} returnDate="" onReturn={noop} tried={false} />],
  ["return from leave", () => <LifecycleWhat detail={c.d} kind="RETURN_FROM_LEAVE" v={{} as never} set={noop} today="2026-10-23" bounds={{}} lastLeave={event} contractEnd={null} show={() => false} correcting={false} what={{ current: null }} tried={false} />],
  ["appointment notice", () => {
    reads.notice = notice("FUTURE_LEAVE");
    return <NoticePage />;
  }],
] as const)("%s renders a future leave type as a neutral label and muted code", (_, screen) => {
  const html = renderToStaticMarkup(screen());
  expect(html).toContain("확인되지 않은 항목");
  expect(html).toContain('<span class="chip chip--neutral">FUTURE_LEAVE</span>');
  expect(html.split("FUTURE_LEAVE")).toHaveLength(2);
});
