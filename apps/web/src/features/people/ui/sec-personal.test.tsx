// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { loadCatalog, t } from "@console/i18n";
import { SecPersonal } from "./sec-personal";
import type { Card } from "./use-card";
import type { Quick } from "./use-quick";

const rrnRead = vi.hoisted(() => ({ recorded: false, can_record: true }));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: { employee_id: "person", recorded: rrnRead.recorded, can_record: rrnRead.can_record, masked: "••••••-•••••••" }, isPending: false, isError: false }),
}));

vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock("./photo-row", () => ({ PhotoRow: () => null }));
vi.mock("./emergency-contacts", () => ({ EmergencyContacts: () => null }));
beforeAll(() => loadCatalog("ko"));

function card(readable: boolean, editable = false, recorded = false, status = "ACTIVE") {
  rrnRead.recorded = recorded;
  const c = { e: { id: "person", name: "한기록", employee_number: "1001", status },
    d: { employment: { phone_e164: "+821012345821" } }, readable, editable,
    personal: { data: { personal_email: "personal@example.com" } },
    register: { data: { address: { si_nm: "경기도", sgg_nm: "평택시" } } },
    facts: { data: { birth_date: "1965-01-01" } },
  } as unknown as Card;
  const quick = { conflictFor: () => undefined } as unknown as Quick;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><SecPersonal c={c} quick={quick} onFix={() => {}} /></QueryClientProvider>);
  client.clear(); return html;
}

test("all four personal fields offer a separate governed reveal even on a read-only card", () => {
  const html = card(true);
  for (const id of ["birth", "address", "phone", "personalEmail"] as const) {
    expect(html).toContain(t("empCard.reveal.open", { field: t(`empCard.f.${id}`) }));
  }
  expect(html).not.toContain("1965");
  expect(html).not.toContain("personal@example.com");
  expect(html).not.toContain("12345821");
});

test("the RRN row keeps its empty state separate from the shared first-entry mark", () => {
  const html = card(true, true);
  expect(html).not.toContain("</span> · ");
  expect(html).toContain('data-acts="true"');
  expect(card(true, false, false, "EXITED")).not.toContain(">기록</button>");
});

test("a reader without the reveal right has no reveal control", () => {
  const html = card(false);
  for (const id of ["birth", "address", "phone", "personalEmail"] as const) {
    expect(html).not.toContain(t("empCard.reveal.open", { field: t(`empCard.f.${id}`) }));
  }
});

test("recording is offered only on an editable readable card without a number", () => {
  const action = ">기록</button>";
  expect(card(true, true)).toContain(action);
  for (const html of [card(false, true), card(true, false), card(true, true, true)]) expect(html).not.toContain(action);
  expect(card(true, true)).toContain(t("empCard.rrn.open"));
  expect(card(true, true)).not.toContain("법적 근거 확인 중");
});

test("a readable editable card respects the server's recording refusal", () => {
  rrnRead.can_record = false;
  expect(card(true, true)).not.toContain(">기록</button>");
});
