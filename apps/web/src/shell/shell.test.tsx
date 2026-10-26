// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { loadCatalog } from "@console/i18n";
import { myAccessQuery } from "../reference/authz/api";
import { activeSupportQuery } from "../reference/support-access/api";
import { Shell } from "./shell";

const child = vi.hoisted(() => vi.fn(() => "private page"));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>, Outlet: () => child(),
  useNavigate: () => vi.fn(), useLocation: () => ({ pathname: "/people" }),
  useRouter: () => ({ routesByPath: Object.fromEntries([
    ["/", "signed-in"], ["/requests", "signed-in"], ["/people/requests", "signed-in"],
    ["/people", { domain: "hr_basic", level: "view" }],
  ].map(([path, access]) => [path, { options: { staticData: { access } } }])) }),
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) => select([
    { staticData: { access: "signed-in" } }, { staticData: { access: { domain: "hr_basic", level: "view" } } },
  ]),
}));
vi.mock("./theme", () => ({ useTheme: () => ["light", vi.fn()] }));
vi.mock("./session-recovery", () => ({ SessionRecovery: ({ children }: { children: ReactNode }) => children }));
vi.mock("./phase-band", () => ({ PhaseBand: ({ children }: { children: ReactNode }) => children }));
vi.mock("../ui/live/live-status", () => ({ LiveStatus: () => null }));
vi.mock("../ui/live/change-notice", () => ({ ChangeNotice: () => null }));
vi.mock("../ui/live/held-notice", () => ({ HeldNotice: () => null }));
vi.mock("../auth/domain-notice", () => ({ DomainNotice: () => null }));
vi.mock("../features/support-access/ui/support-access", () => ({ ActiveSupportBanner: () => null }));
beforeAll(() => loadCatalog("ko"));

test.each(["neither", "access", "support", "both"])("navigation waits for both decisions: %s ready", async ready => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  if (ready === "access" || ready === "both") await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
  if (ready === "support" || ready === "both") await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: true }) });
  try {
    const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
    const links = [...rail.matchAll(/href="([^"]+)"/g)].map(([, path]) => path).filter(path => path !== "#main");
    expect(links).toEqual(ready === "both" ? ["/", "/requests", "/people", "/people/requests", "/audit/support-access"] : ["/", "/requests"]);
  } finally { client.clear(); }
});

test("the shell withholds its outlet when the leaf read is refused", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: false, entries: [] }) });
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
    expect(child).not.toHaveBeenCalled();
    expect(html.match(/aria-label="이 화면에 접근 권한이 없습니다"/g)).toHaveLength(1);
    expect(html).not.toContain("private page");
  } finally { client.clear(); }
});
