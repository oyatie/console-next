// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { privacyFilingOptionsQuery, privacyRequestPages } from "../api";
import { PrivacyRequests } from "./privacy-page";

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({ useSearch: () => ({}), useNavigate: () => () => {} }),
  useParams: () => ({}),
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../../../experience/dom", async original => ({
  ...await original<typeof import("../../../experience/dom")>(),
  useActiveExperienceId: () => "console" as const,
}));

beforeAll(() => loadCatalog("ko"));

// An account no controller is linked to can file nothing; the page says so instead of dropping the filing section.
test("an unlinked account is told it has no right to file here", async () => {
  const client = new QueryClient();
  await client.fetchInfiniteQuery({ ...privacyRequestPages, queryFn: async () => ({ items: [], next_cursor: null, as_of: "2026-10-26" }) });
  await client.fetchQuery({ ...privacyFilingOptionsQuery, queryFn: async () => ({ subject_user_id: "user-1", controllers: [], kinds: [], detail_max_length: 2000, reply_email_masked: null, as_of: "2026-10-26" }) });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><PrivacyRequests /></QueryClientProvider>);
  expect(html).toContain(t("account.privacy.file"));
  expect(html).toContain(t("account.privacy.unavailable"));
});
