import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ApiError } from "../../../reference/statutory/api";
import { loadCatalog, t } from "@console/i18n";
import type { FilingTask } from "../../../reference/statutory/api";
import { CommandError } from "../../../lib/react/command-error";
import { FilingDeadline } from "../../../reference/statutory/ui/filing-deadline";
import { StatutoryPage } from "./statutory-page";

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useSearch: () => ({}), useNavigate: () => () => {},
}));
import { FilingWindow } from "./filing-deadline";

beforeAll(() => loadCatalog("ko"));
test("a held workplace read reserves the statutory page layout", async () => {
  const client = new QueryClient();
  const root = createRootRoute({ component: StatutoryPage });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>);
  expect(html).toContain('data-read-layout="list"');
  expect(html).toContain("<h1");
  expect(html).toContain(t("statutory.title"));
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-busy="true"');
  client.clear();
});
test.each(["filing_record_invalid", "filing_stale", "filing_event_inactive", "filing_applicability_unverified", "filing_not_applicable_invalid", "filing_request_invalid", "filing_remuneration_required"])("%s explains the refusal without claiming completion", async (code) => {
  const root = createRootRoute({ component: () => <CommandError error={new ApiError(409, code, "unsafe fallback", [], undefined, true)} /> });
  const router = createRouter({ routeTree: root, history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  const html = renderToStaticMarkup(<RouterProvider router={router} />);
  expect(html).toContain('role="alert"');
  expect(html).toContain(t(`common.failed.code.${code}` as "common.failed.code.filing_stale"));
  expect(html).not.toContain("unsafe fallback");
  expect(html).not.toContain("완료를 기록했습니다");
});
test("an unverified clock never invents a deadline, and a held overdue date keeps both facts", () => {
  const task = { due_date: null, due_in_days: null, deadline_status: "UNKNOWN" } as FilingTask;
  const unknown = renderToStaticMarkup(<FilingDeadline task={task} />);
  expect(unknown).toContain("기한 미확인");
  expect(unknown).not.toContain("D-");
  const overdue = renderToStaticMarkup(<FilingDeadline task={{ ...task, due_date: "2026-09-15", due_in_days: -3, deadline_status: "HOLD" }} />);
  expect(overdue).toContain("기한 지남");
  expect(overdue).toContain("노무사 검토 전");
});

test("a filing window shows one opening and the legal deadline without a duplicate target", () => {
  const task = { opens_on: "2026-10-01", target_on: "2026-10-01", due_date: "2026-10-15", due_in_days: 2, deadline_status: "HOLD" } as FilingTask;
  const html = renderToStaticMarkup(<FilingWindow task={task} />);
  expect(html.match(/dateTime="2026-10-01"/g)).toHaveLength(1);
  expect(html).toContain(t("statutory.opens"));
  expect(html).toContain(t("statutory.deadline"));
  expect(html).toContain("D-2");
  expect(html).not.toContain(t("statutory.target"));
});
