// SPDX-License-Identifier: LicenseRef-Proprietary
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { opsQueryKeys, type OpsJobs, type OpsMe } from "../lib/api";
import { OpsContext } from "../lib/ops-context";
import { JobsTab } from "./jobs-tab";

const ME: OpsMe = {
  evaluated_at: "2026-11-21T21:40:00Z",
  operator: { person: "11111111-1111-4111-8111-111111111111", display_email: "oncall@cosskorea.invalid" },
  grants: [],
  allowed_actions: ["read.me", "read.running", "jobs.rerun"],
};

const JOBS: OpsJobs = {
  evaluated_at: "2026-11-21T21:40:00Z",
  jobs: [
    {
      name: "pgbackrest-incr",
      state: { state: "Verified", value: "Succeeded", unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
      last_run: { state: "Verified", value: "2026-11-21T21:00:00Z", unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
      last_exit: { state: "Verified", value: 0, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
      budget: { state: "Verified", value: 900, unit: "s", source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
      next_run: { state: "Verified", value: "2026-11-21T22:00:00Z", unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
    },
    {
      name: "billing-export",
      state: { state: "Verified", value: "Late", unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
      last_run: { state: "Verified", value: "2026-11-21T18:00:00Z", unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
      last_exit: { state: "Verified", value: 1, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
      budget: { state: "Verified", value: 7200, unit: "s", source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
    },
  ],
  count: { state: "Verified", value: 2, unit: null, source: "textfile", observed_at: "2026-11-21T21:40:00Z", age_s: 12 },
};

async function renderWithQuery(node: ReactNode) {
  const qc = new QueryClient();
  qc.setQueryData(opsQueryKeys.jobs, JOBS);
  const root = createRootRoute({ component: () => node });
  const router = createRouter({
    routeTree: root.addChildren([
      createRoute({ getParentRoute: () => root, path: "/running/jobs", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/running", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/changes", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/promote", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/actions", component: () => null }),
      createRoute({ getParentRoute: () => root, path: "/runbooks", component: () => null }),
    ]),
    history: createMemoryHistory({ initialEntries: ["/running/jobs"] }),
  });
  await router.load();
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: qc },
      createElement(
        OpsContext.Provider,
        {
          value: {
            me: ME,
            live: { status: "Live", paused: false, pendingCount: 0, lastEventAt: null, disconnectedSince: null, disconnectedAgeS: 0 },
            reportEvaluatedAt: () => {},
          },
        },
        createElement(RouterProvider, { router }),
      ),
    ),
  );
}

describe("JobsTab 390px secondary metadata and rerun action", () => {
  test("renders desktop columns and Rerun button cleanly", async () => {
    const html = await renderWithQuery(createElement(JobsTab, {}));
    expect(html).toContain("pgbackrest-incr");
    expect(html).toContain("billing-export");
    expect(html).toContain("Not scheduled");
    expect(html).toContain("Rerun");
  });

  test("renders phone Line 2 with exit code and Next timestamp", async () => {
    const html = await renderWithQuery(createElement(JobsTab, { isPhoneOverride: true }));
    expect(html).toContain("exit ");
    expect(html).toContain("Next:");
    expect(html).toContain("11-21 22:00Z");
    expect(html).toContain("Not scheduled");
  });
});
