// SPDX-License-Identifier: LicenseRef-Proprietary
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { loadCatalog, t } from "@console/i18n";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RrnCard } from "./rrn-card";

const status = vi.hoisted(() => ({ recorded: false, can_record: true }));
vi.mock("@tanstack/react-query", async importOriginal => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQuery: () => ({ data: { ...status, masked: "••••••-•••••••" }, isPending: false, isError: false }),
}));
beforeAll(() => loadCatalog("ko"));
beforeEach(() => Object.assign(status, { recorded: false, can_record: true }));
function card(employeeStatus: "ACTIVE" | "EXITED" = "ACTIVE") {
  const client = new QueryClient();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RrnCard employeeId="person" employeeStatus={employeeStatus} who="한기록" /></QueryClientProvider>);
  client.clear();
  return html;
}

test("identifiers offers recording when there is no recorded number", () => {
  const html = card();
  expect(html).toContain(t("empCard.rrn.none"));
  expect(html).toContain(">기록</button>");
});

test("the empty state and entry action use separate field slots without a separator", () => {
  const html = card();
  expect(html).not.toMatch(/기록 없음<\/span> ·|기록 없음 ·/);
  expect(html).toContain('data-acts="true"');
});

test("identifiers does not offer entry for an exited person", () => {
  expect(card("EXITED")).not.toContain(">기록</button>");
});

test.each([[false, false], [true, false], [true, true]])("recorded=%s, permitted=%s offers no recording", (recorded, can_record) => {
  Object.assign(status, { recorded, can_record });
  const html = card();
  expect(html).not.toContain(">기록</button>");
});
