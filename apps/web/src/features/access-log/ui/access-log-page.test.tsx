// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import type { StatRowItem } from "../../../ui/key-value/key-value";
import { accessLogPages } from "../api";
import { AccessLogPage } from "./access-log-page";

const navigate = vi.fn();
let stats: readonly StatRowItem[] = [];

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({ useSearch: () => ({ period: "2026-10" }), useNavigate: () => navigate }),
}));
vi.mock("../../../experience/dom", async original => ({
  ...await original<typeof import("../../../experience/dom")>(),
  useActiveExperienceId: () => "console" as const,
}));
vi.mock("../../../lib/react/use-desktop", () => ({ useIsDesktop: () => false }));
vi.mock("../../../reference/audit/ui/audit-tabs", () => ({ AuditTabs: () => null }));
vi.mock("../../../ui/long-table/long-table", () => ({ LongTable: () => null }));
vi.mock("../../../ui/key-value/key-value", async original => ({
  ...await original<typeof import("../../../ui/key-value/key-value")>(),
  StatRow: ({ items }: { items: readonly StatRowItem[] }) => { stats = items; return null; },
}));

beforeAll(() => loadCatalog("ko"));
beforeEach(() => { navigate.mockReset(); stats = []; });

const event = { id: "evt-1", occurred_at: "2026-10-05T09:00:00Z", actor: { id: "user-1", label: "Synthetic actor" }, action: "employee.export", target_type: "employee", subject_count: 1, result: "allowed", flags: ["download"], ip: "203.0.113.10" };
const page = { period: { from: "2026-10-01", to: "2026-10-31", time_zone: "Asia/Seoul", closed: true }, totals: { events: 3, flagged: 1, by_flag: {} }, items: [event], next_cursor: null };

const render = (client: QueryClient) => renderToStaticMarkup(<QueryClientProvider client={client}><AccessLogPage /></QueryClientProvider>);
const reviewButton = (html: string) => html.match(new RegExp(`<button[^>]*>${t("accessLog.review.open")}</button>`))?.[0];

// The head's actions keep their places from the first frame: the review action waits disabled, rather than arriving
// with the records and pushing the filter action aside.
test("the review action holds its place while the month loads", () => {
  const button = reviewButton(render(new QueryClient()));
  expect(button).toBeDefined();
  expect(button).toContain("disabled");
});

// Choosing all records or the ones to review is a step Back undoes, as the Classic links are.
test("changing the view adds a history entry", () => {
  const client = new QueryClient();
  client.setQueryData(accessLogPages("2026-10", true, undefined, {}).queryKey, { pages: [page], pageParams: [undefined] });
  expect(reviewButton(render(client))).not.toContain("disabled");
  expect(stats.map(item => item.key)).toEqual(["events", "flagged"]);
  for (const item of stats) item.onPress!();
  expect(navigate).toHaveBeenCalledTimes(2);
  for (const [options] of navigate.mock.calls) expect(options.replace).toBeUndefined();
});
