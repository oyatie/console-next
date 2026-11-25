// SPDX-License-Identifier: LicenseRef-Proprietary
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog, t } from "@console/i18n";
import { certificatesQuery } from "../api/certificates";
import { CertificatesPage } from "./certificates-page";

vi.mock("@tanstack/react-router", async original => ({
  ...await original<typeof import("@tanstack/react-router")>(),
  getRouteApi: () => ({ useSearch: () => ({ employee: "emp-1" }) }),
  useLocation: () => "",
  useNavigate: () => () => {},
  Link: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("../../../experience/dom", async original => ({
  ...await original<typeof import("../../../experience/dom")>(),
  useActiveExperienceId: () => "console" as const,
}));

beforeAll(() => loadCatalog("ko"));

const certificate = { id: "cert-1", certificate_no: "C-2026-0001", name: "검증직원", kind: "EMPLOYMENT", issued_at: "2026-10-26T09:00:00Z", voided_at: null };

// The person card reads one person's certificates as a plain list; the register pages the same list, so a shared
// cache entry would hand the register a page it cannot read.
test("the register opens after the person card has read the same person's certificates", () => {
  const client = new QueryClient();
  client.setQueryData(certificatesQuery("emp-1").queryKey, { items: [certificate], next_cursor: null });
  const html = renderToStaticMarkup(<QueryClientProvider client={client}><CertificatesPage /></QueryClientProvider>);
  expect(html).toContain(t("empDoc.certificate.register"));
});
