import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { beforeAll, expect, test } from "vitest";
import type { components } from "@console/api/schema";
import { loadCatalog, t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { label, ORG_CHANGE_KIND, ORG_CHANGE_STATUS } from "../../../lib/labels";
import { WaitingList } from "./change-rows";

type Change = components["schemas"]["OrgChangeSummary"];
beforeAll(() => loadCatalog("ko"));

const change: Change = {
  id: "change-id", code: "OC-2026-0012", kind: "REORG", status: "IN_APPROVAL",
  target: { kind: "ORG_UNIT", ref: "target-unit", label: "Target unit" },
  effectiveDate: "2026-10-16", reason: "Reviewed reason", headcount: 5, siteCount: 1, teamCount: 2,
  draftedBy: "drafter-id", draftedByName: "Drafter", createdAt: "2026-10-09T05:06:00Z", updatedAt: "2026-10-09T05:06:00Z",
};

async function html(changes: Change[]) {
  const root = createRootRoute({ component: () => <WaitingList changes={changes} /> });
  const detail = createRoute({ getParentRoute: () => root, path: "/org/changes/$id" });
  const outcome = createRoute({ getParentRoute: () => root, path: "/requests/$id" });
  const router = createRouter({ routeTree: root.addChildren([detail, outcome]), history: createMemoryHistory({ initialEntries: ["/"] }) });
  await router.load();
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

test.each(["IN_APPROVAL", "APPROVED"] as const)("waiting %s links its durable outcome while keeping the change row", async (status) => {
  const row = { ...change, status, commandId: "durable-command-id" };
  const markup = await html([row]);
  expect(markup).toContain(row.code);
  expect(markup).toContain(label(ORG_CHANGE_KIND, row.kind));
  expect(markup).toContain(row.target.label);
  expect(markup).toContain(fmtDate(row.effectiveDate));
  expect(markup).toContain(label(ORG_CHANGE_STATUS, row.status));
  expect(markup).toContain('href="/org/changes/change-id"');
  expect(markup).toContain('href="/requests/durable-command-id"');
  expect(markup).toContain(t("requestOutcome.open"));
  expect(markup.match(/<a /g)).toHaveLength(2);
});

test("legacy waiting changes retain their original detail link without a dead outcome link", async () => {
  const markup = await html([change]);
  expect(markup).toContain('href="/org/changes/change-id"');
  expect(markup).not.toContain("/requests/");
  expect(markup).not.toContain(t("requestOutcome.open"));
  expect(markup.match(/<a /g)).toHaveLength(1);
});

test("empty waiting lane keeps its existing message", async () => {
  const markup = await html([]);
  expect(markup).toContain(t("home.waiting.empty"));
  expect(markup).toContain('class="muted"');
  expect(markup).not.toContain("<section");
  expect(markup).not.toContain("<a ");
});
