// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { jobTitlesQuery } from "../api";
import { JobTitlesPage } from "./job-titles-page";
import sf from "./settings-form.module.css";

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  useRouter: () => ({ routesByPath: {} }),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../experience/dom", async original => ({
  ...await original<typeof import("../../../experience/dom")>(),
  useActiveExperienceId: () => "console" as const,
}));

beforeAll(() => loadCatalog("ko"));

// Console's table sizes its columns to their content, so a full-length name with no break (keep-all Korean, one long word) must wrap in its own cell;
// otherwise it widens the table and pushes the row's actions past the window.
test("a full-length title wraps in its cell rather than widening the table", () => {
  const label = "W".repeat(60);
  const client = new QueryClient();
  client.setQueryData(jobTitlesQuery.queryKey, { can_manage: true, items: [{ id: "jt-1", kind: "TITLE", label, grade_rank: 10, active: true }] });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><JobTitlesPage /></QueryClientProvider>);
  expect(html).toContain(`<span class="${sf.wrap}">${label}</span>`);
});
