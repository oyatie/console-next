// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { session } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { loadPack } from "../../experience/pack";
import { myAccessQuery } from "../../reference/authz/api";
import { activeSupportQuery } from "../../reference/support-access/api";
import { meQuery } from "../../features/account/api";
import { checklistQuery, modulesQuery } from "../../features/onboarding/api";
import { navigationRead } from "../../lib/query";
import { modules, screenAccess, token } from "../../../../../e2e/mock/fixtures";
import BaselineShell from "../baseline/shell";
import { ShellFrame, type ShellLayoutProps } from "./shell-frame";

const locationState = vi.hoisted(() => ({ pathname: "/account" }));
vi.mock("react", async original => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>,
  Outlet: () => null,
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: locationState.pathname }),
  useRouter: () => ({
    routesByPath: Object.fromEntries(
      [
        ["/", "signed-in"],
        ["/requests", "signed-in"],
        ["/people/requests", "signed-in"],
        ["/approvals", "signed-in"],
        ["/people", { domain: "hr_basic", level: "view" }],
        ["/people/exits", { domain: "hr_basic", level: "view" }],
        ["/org", { domain: "org", level: "view" }],
      ].map(([path, access]) => [path, { options: { staticData: { access } } }]),
    ),
  }),
  useMatches: ({ select }: { select: (matches: unknown[]) => unknown }) => select([{ staticData: { access: "signed-in" } }]),
}));
vi.mock("../theme", () => ({ useTheme: () => ["light", vi.fn()] }));
vi.mock("../session-recovery", () => ({ SessionRecovery: ({ children }: { children: ReactNode }) => children }));
vi.mock("../phase-band", () => ({ PhaseBand: ({ children }: { children: ReactNode }) => children }));
vi.mock("../../ui/live/live-status", () => ({ LiveStatus: () => null }));
vi.mock("../../ui/live/change-notice", () => ({ ChangeNotice: () => null }));
vi.mock("../../ui/live/held-notice", () => ({ HeldNotice: () => null }));
vi.mock("../../auth/domain-notice", () => ({ DomainNotice: () => null }));
vi.mock("../../features/support-access/ui/support-access-status", () => ({
  ActiveSupportBanner: () => null,
  SupportAccessIndicator: () => null,
}));

beforeAll(() => loadCatalog("ko"));

test("ShellFrame sets self-service phoneNav only for linked non-admin employees on /account and default routes", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const seenPhoneNav: Array<string | undefined> = [];
  function CaptureLayout({ phoneHeader }: ShellLayoutProps) {
    seenPhoneNav.push(phoneHeader?.phoneNav);
    return <div>{phoneHeader?.phoneNav ?? "desk"}</div>;
  }
  try {
    session.set(token());
    await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
    await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: false }) });
    await client.fetchQuery({ ...checklistQuery, queryFn: async () => ({ steps: [] }) });

    await client.fetchQuery({ ...myAccessQuery, staleTime: 0, queryFn: async () => ({ is_ops: false, entries: [] }) });
    await client.fetchQuery({
      ...navigationRead(meQuery),
      staleTime: 0,
      queryFn: async () => ({
        employee_link_status: "LINKED",
        display_name: "Ha-jun Yoon",
        tenant: { name: "Saeon Group", phase: "OPERATING" },
      }),
    });
    await client.fetchQuery({
      ...meQuery,
      staleTime: 0,
      queryFn: async () => ({
        employee_link_status: "LINKED",
        display_name: "Ha-jun Yoon",
        tenant: { name: "Saeon Group", phase: "OPERATING" },
      }),
    });
    for (const path of ["/account", "/account/privacy", "/"]) {
      locationState.pathname = path;
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ShellFrame layout={CaptureLayout} />
        </QueryClientProvider>,
      );
    }
    expect(seenPhoneNav.slice(-3)).toEqual(["self-service", "self-service", "self-service"]);

    await client.fetchQuery({ ...myAccessQuery, staleTime: 0, queryFn: async () => screenAccess("/people") });
    for (const path of ["/account", "/"]) {
      locationState.pathname = path;
      renderToStaticMarkup(
        <QueryClientProvider client={client}>
          <ShellFrame layout={CaptureLayout} />
        </QueryClientProvider>,
      );
    }
    expect(seenPhoneNav.slice(-2)).toEqual([undefined, undefined]);
  } finally {
    locationState.pathname = "/account";
    session.set(null);
    client.clear();
  }
});

test("ConsoleShell renders distinct sub-route tab titles for /people/exits while BaselineShell stays unaltered", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const origDocument = globalThis.document;
  try {
    session.set(token());
    await client.fetchQuery({ ...myAccessQuery, queryFn: async () => screenAccess("/people") });
    await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
    await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: false }) });
    await client.fetchQuery({ ...checklistQuery, queryFn: async () => ({ steps: [] }) });
    await client.fetchQuery({
      ...navigationRead(meQuery),
      queryFn: async () => ({ display_name: "Seoyeon Moon", tenant: { name: "Saeon Group", phase: "OPERATING" } }),
    });

    vi.stubGlobal("document", { documentElement: { dataset: { experience: "console" } } });
    const ConsolePack = (await loadPack()).default;
    vi.unstubAllGlobals();

    locationState.pathname = "/people/exits";
    const exitsHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConsolePack>
          <h1>{t("shellRoutes.peopleExits")}</h1>
        </ConsolePack>
      </QueryClientProvider>,
    );
    const exitsTabs = exitsHtml.split(`aria-label="${t("shell.tabs.label")}"`)[1]?.split("</nav>")[0] ?? "";
    expect(exitsTabs).toContain(t("shellRoutes.peopleExits"));
    expect(exitsTabs).not.toContain(`>${t("shell.link.people")}<`);

    const baselineHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <BaselineShell>
          <h1>{t("shellRoutes.peopleExits")}</h1>
        </BaselineShell>
      </QueryClientProvider>,
    );
    expect(baselineHtml).not.toContain("data-workspace-tab");
  } finally {
    locationState.pathname = "/account";
    vi.stubGlobal("document", origDocument);
    session.set(null);
    client.clear();
  }
});
