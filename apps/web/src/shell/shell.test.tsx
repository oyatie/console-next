// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError, session } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { myAccessQuery } from "../reference/authz/api";
import { activeSupportQuery } from "../reference/support-access/api";
import { read } from "../lib/query";
import { Shell } from "./shell";
import { meQuery } from "../features/account/api";
import { checklistQuery, modulesQuery, SETUP_READS } from "../features/onboarding/api";
import { modules } from "../../../../e2e/mock/fixtures";
import { invalidatePaths, navigationRead } from "../lib/query";

const child = vi.hoisted(() => vi.fn(() => "private page"));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>, Outlet: () => child(),
  useNavigate: () => vi.fn(), useLocation: () => ({ pathname: "/people" }),
  useRouter: () => ({ routesByPath: Object.fromEntries([
    ["/", "signed-in"], ["/requests", "signed-in"], ["/people/requests", "signed-in"],
    ["/people", { domain: "hr_basic", level: "view" }], ["/audit/support-access", "signed-in"],
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

test("go-live invalidates the cached tenant phase used by the shell", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  let phase = "SETUP";
  const currentUser = { ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase } }) };
  try {
    expect((await client.fetchQuery(currentUser)).tenant.phase).toBe("SETUP");
    phase = "OPERATING";
    await Promise.all(invalidatePaths(client, SETUP_READS));
    expect((await client.fetchQuery(currentUser)).tenant.phase).toBe("OPERATING");
  } finally { client.clear(); }
});

test.each(["neither", "access", "support", "both"])("navigation waits for both decisions: %s ready", async ready => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
  await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "OPERATING" } }) });
  if (ready === "access" || ready === "both") await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
  if (ready === "support" || ready === "both") await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: true }) });
  try {
    const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
    const links = [...rail.matchAll(/href="([^"]+)"/g)].map(([, path]) => path).filter(path => path !== "#main");
    expect(links).toEqual(ready === "both" ? ["/", "/people/requests", "/people", "/audit/support-access"] : []);
  } finally { client.clear(); }
});

test.each(["blocked", "todo"])("the shell projects the server's %s employees step", async state => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
  await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "SETUP" } }) });
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
  await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: false }) });
  await client.fetchQuery({ ...checklistQuery, queryFn: async () => ({ steps: [{ state, action: "register_employee" }] }) });
  try {
    const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
    expect(rail.includes('href="/people"')).toBe(state !== "blocked");
    expect(rail).not.toContain('href="/people/requests"');
  } finally { client.clear(); }
});

test("SETUP keeps the loading rail while the checklist is pending", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "SETUP" } }) });
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
  await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: true }) });
  try {
    const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
    expect([...rail.matchAll(/href="([^"]+)"/g)].map(([, path]) => path).filter(path => path !== "#main")).toEqual([]);
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

test("the top bar waits for the restored identity instead of painting a temporary name", () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const render = () => renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
  try {
    session.set(null);
    const pending = render().match(/<header[\s\S]*?<\/header>/)![0];
    expect(pending).toContain('aria-busy="true"');
    expect(pending).not.toContain(t("shell.logout"));
    expect(pending).not.toContain(t("account.name.unset"));
    session.set({ access_token: `h.${Buffer.from(JSON.stringify({ sub: "operator", org: "tenant", name: "김담당", platform: true })).toString("base64url")}.s`, token_type: "Bearer", refresh_expires_at: "2099-01-01T00:00:00Z", requires_passkey_setup: false });
    const ready = render().match(/<header[\s\S]*?<\/header>/)![0];
    expect(ready).not.toContain('aria-busy="true"');
    expect(ready).toContain("김담당");
    expect(ready).toContain(t("shell.logout"));
  } finally { session.set(null); client.clear(); }
});

test("a failed session restore keeps the navigation and device controls available", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  try {
    session.set(null);
    await expect(client.fetchQuery(read("/api/v1/auth/token/refresh", () => Promise.reject(new Error("unavailable"))))).rejects.toThrow("unavailable");
    const header = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).match(/<header[\s\S]*?<\/header>/)![0];
    expect(header).not.toContain('aria-busy="true"');
    for (const key of ["shell.menu", "shell.locale", "shell.theme.toDark", "shell.logout", "account.name.unset"] as const) expect(header).toContain(t(key));
  } finally { session.set(null); client.clear(); }
});

for (const secondary of ["modules", "support", "me"] as const) for (const cached of [false, true]) {
  test(`${secondary} 403 gives a fresh rail with ${cached ? "cached" : "no previous"} secondary data`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    try {
      await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
      if (cached || secondary !== "modules") await client.fetchQuery({ ...modulesQuery, queryFn: async () => secondary === "modules" ? modules["not-ready"] : modules.ready });
      if (cached || secondary !== "support") await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: true }) });
      if (cached || secondary !== "me") await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: cached && secondary === "me" ? "SETUP" : "OPERATING" } }) });
      await client.fetchQuery({ ...checklistQuery, queryFn: async () => ({ steps: [] }) });
      const query = secondary === "modules" ? modulesQuery : secondary === "support" ? activeSupportQuery : navigationRead(meQuery);
      const refusal = new ApiError(403, "forbidden", "", []);
      await expect(client.fetchQuery({ ...query, staleTime: 0, queryFn: async () => { throw refusal; } })).rejects.toBe(refusal);
      const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
      expect(rail).toContain('href="/people"');
      expect(rail.includes('href="/audit/support-access"')).toBe(secondary !== "support");
      expect(rail).not.toContain('aria-busy="true"');
    } finally { client.clear(); }
  });
}

for (const secondary of ["modules", "support", "me"] as const) for (const fault of [new ApiError(503, "unavailable", "", []), new TypeError("Failed to fetch")]) {
  test(`${secondary} ${fault.name} fault keeps a cold rail unresolved`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    try {
      await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
      await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
      await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: true }) });
      await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "OPERATING" } }) });
      const query = secondary === "modules" ? modulesQuery : secondary === "support" ? activeSupportQuery : navigationRead(meQuery);
      await expect(client.fetchQuery({ ...query, staleTime: 0, queryFn: async () => { throw fault; } })).rejects.toBe(fault);
      const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
      expect(rail).toContain('aria-busy="true"');
      expect(rail).not.toContain('href="/people"');
    } finally { client.clear(); }
  });
}
