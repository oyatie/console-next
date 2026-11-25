// SPDX-License-Identifier: LicenseRef-Proprietary
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeAll, expect, test, vi } from "vitest";
import { ApiError, session } from "@console/api";
import { loadCatalog, t } from "@console/i18n";
import { experiences } from "../experience/table";
import { loadPack } from "../experience/pack";
import { PLATFORM_NAV } from "./nav";
import { myAccessQuery } from "../reference/authz/api";
import { activeSupportQuery } from "../reference/support-access/api";
import { read } from "../lib/query";
import Shell from "./baseline/shell";
import { AccountLink, LogoutButton, SearchTrigger, ThemeToggle } from "./frame/controls";
import { LocaleSelect } from "./frame/locale-select";
import type { ShellLayoutProps } from "./frame/shell-frame";
import { meQuery } from "../features/account/api";
import { checklistQuery, modulesQuery, SETUP_READS } from "../features/onboarding/api";
import { modules, screenAccess, token } from "../../../../e2e/mock/fixtures";
import { invalidatePaths, navigationRead } from "../lib/query";

const child = vi.hoisted(() => vi.fn(() => "private page"));
const locationState = vi.hoisted(() => ({ pathname: "/people" }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to }: { children: ReactNode; to: string }) => <a href={to}>{children}</a>, Outlet: () => child(),
  useNavigate: () => vi.fn(), useLocation: () => ({ pathname: locationState.pathname }),
  useRouterState: ({ select }: { select: (state: { status: string }) => unknown }) => select({ status: "idle" }),
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
vi.mock("../features/support-access/ui/support-access-status", () => ({ ActiveSupportBanner: () => null, SupportAccessIndicator: () => null }));
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

test.each([
  { kind: "grantless", is_ops: false, entries: [], enabled: false },
  { kind: "prepared", is_ops: false, entries: screenAccess("/people").entries.map(e => ({ ...e, enforcement: "PREPARED" })), enabled: false },
  { kind: "enforced", is_ops: false, entries: screenAccess("/people").entries, enabled: true },
  { kind: "request-only", is_ops: false, entries: screenAccess("/people").entries.map(e => ({ ...e, domain: "todo_request" })), enabled: false },
  { kind: "ops", is_ops: true, entries: [], enabled: true },
])("SETUP rail only waits for a held checklist read: $kind", async ({ is_ops, entries, enabled }) => {
  const client = new QueryClient();
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops, entries }) });
  await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "SETUP" } }) });
  await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: false }) });
  await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
  try {
    session.set(token());
    const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
    expect(client.getQueryCache().find(checklistQuery)?.options).toMatchObject({ enabled });
    expect(rail.includes('href="/"')).toBe(!enabled);
  } finally { session.set(null); client.clear(); }
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
  test(`${secondary} 403 resolves the rail with ${cached ? "cached" : "no previous"} secondary data`, async () => {
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
      expect(rail.includes('href="/people"')).toBe(secondary !== "me");
      expect(rail.includes('href="/audit/support-access"')).toBe(secondary === "modules");
      if (secondary === "me") expect(rail).toContain(t("common.failed.permanent", { status: "403" }));
      expect(rail).not.toContain('aria-busy="true"');
    } finally { client.clear(); }
  });
}

for (const secondary of ["support", "me"] as const) for (const fault of [new ApiError(503, "unavailable", "", []), new TypeError("Failed to fetch")]) {
  test(`${secondary} ${fault.name} fault shows a cold rail read error`, async () => {
    const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
    try {
      await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
      await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
      await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: true }) });
      await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "OPERATING" } }) });
      const query = secondary === "support" ? activeSupportQuery : navigationRead(meQuery);
      await expect(client.fetchQuery({ ...query, staleTime: 0, queryFn: async () => { throw fault; } })).rejects.toBe(fault);
      const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
      expect(rail).not.toContain('aria-busy="true"');
      expect(rail).toContain(t(secondary === "support" ? "shell.nav.failed" : "common.retry"));
      expect(rail).not.toContain('href="/people"');
    } finally { client.clear(); }
  });
}

test.each([new ApiError(503, "unavailable", "", []), new TypeError("Failed to fetch")])("a cold modules %s leaves independent, authorized rail links and one retry", async fault => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  try {
    await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
    await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: false }) });
    await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "OPERATING" } }) });
    await expect(client.fetchQuery({ ...modulesQuery, queryFn: async () => { throw fault; } })).rejects.toBe(fault);
    const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
    expect([...rail.matchAll(/href="([^"]+)"/g)].map(([, path]) => path).filter(path => path !== "#main")).toEqual(["/", "/people/requests"]);
    expect(rail.match(/role="alert"/g)).toHaveLength(1);
    expect(rail).toContain(t("common.retry"));
    expect(rail).not.toContain('aria-busy="true"');
  } finally { client.clear(); }
});

test("a cold checklist fault keeps independent rail links without a rail error", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false, retry: false } } });
  try {
    await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
    await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: false }) });
    await client.fetchQuery({ ...navigationRead(meQuery), queryFn: async () => ({ tenant: { phase: "SETUP" } }) });
    await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
    await expect(client.fetchQuery({ ...checklistQuery, queryFn: async () => { throw new TypeError("Failed to fetch"); } })).rejects.toThrow("Failed to fetch");
    const rail = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>).split("</nav>")[0]!;
    expect(rail).toContain('href="/"');
    expect(rail).not.toContain('aria-busy="true"');
    expect(rail).not.toContain('role="alert"');
    expect(rail).not.toContain(t("shell.nav.failed"));
  } finally { client.clear(); }
});

function AlternateLayout({ children, onSearch }: ShellLayoutProps) {
  return <div><header><SearchTrigger onSearch={onSearch} /><LocaleSelect id="alternate-locale" label /><ThemeToggle /><AccountLink /><LogoutButton /></header><nav aria-label={t("shell.nav")} />{children}</div>;
}

test.each([...experiences.map(experience => experience.id), "alternate"])("the %s layout shares the frame landmarks and screen heading", async layout => {
  const { ShellFrame } = await import("./frame/shell-frame");
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: true, entries: [] }) });
  await expect(client.fetchQuery(read("/api/v1/auth/token/refresh", () => Promise.reject(new Error("unavailable"))))).rejects.toThrow("unavailable");
  try {
    const screen = <h1>{t("app.name")}</h1>;
    vi.stubGlobal("document", { documentElement: { dataset: { experience: layout } } });
    const Pack = (await loadPack()).default;
    vi.unstubAllGlobals();
    const html = renderToStaticMarkup(<QueryClientProvider client={client}>{layout === "alternate"
      ? <ShellFrame layout={AlternateLayout}>{screen}</ShellFrame> : <Pack>{screen}</Pack>}</QueryClientProvider>);
    expect(html).toMatch(/<main\b[^>]*data-console-scope=""/);
    const expectedLandmarks = layout === "console"
      ? (["shell.jump", "account.name.unset", "shell.tabs.label", "shell.status.label"] as const)
      : (["shell.jump", "shell.locale", "shell.theme.toDark", "shell.logout", "account.name.unset"] as const);
    for (const key of expectedLandmarks) expect(html).toContain(t(key));
    expect(html.match(/<main\b/g)).toHaveLength(1);
    expect(html.match(/id="main"/g)).toHaveLength(1);
    expect(html.match(/href="#main"/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`<nav\\b[^>]*aria-label="${t("shell.nav")}"`));
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).toContain(`<h1>${t("app.name")}</h1>`);
    expect(html.match(/<main\b[\s\S]*?<\/main>/)![0]).toContain(`<h1>${t("app.name")}</h1>`);
  } finally { client.clear(); }
});


test("platform sessions place platform navigation without tenant search or inbox", () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  session.set({ access_token: `h.${Buffer.from(JSON.stringify({ sub: "operator", platform: true })).toString("base64url")}.s`, token_type: "Bearer", refresh_expires_at: "2099-01-01T00:00:00Z", requires_passkey_setup: false });
  try {
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>);
    const header = html.match(/<header[\s\S]*?<\/header>/)![0];
    expect(header).not.toContain(t("shell.jump"));
    expect(header).not.toContain('data-task-menu="true"');
    const links = [...html.split("</nav>")[0]!.matchAll(/href="([^"#][^"]*)"/g)].map(([, href]) => href);
    expect(links).toEqual(PLATFORM_NAV.flatMap(hub => hub.links.map(link => link.to)));
    expect(html).toContain('data-console-scope="' + t("shell.hub.platform") + '"');
  } finally { session.set(null); client.clear(); }
});

test("ConsoleShell trims whitespace-only profile fields before composing displayName and uses Settings icon for /account without /settings nav link", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const origDocument = globalThis.document;
  try {
    session.set({ access_token: `h.${Buffer.from(JSON.stringify({ sub: "member", org: "tenant" })).toString("base64url")}.s`, token_type: "Bearer", refresh_expires_at: "2099-01-01T00:00:00Z", requires_passkey_setup: false });
    await client.fetchQuery({ ...myAccessQuery, queryFn: async () => ({ is_ops: false, entries: [] }) });
    await client.fetchQuery({ ...modulesQuery, queryFn: async () => modules.ready });
    await client.fetchQuery({ ...activeSupportQuery, queryFn: async () => ({ can_approve: false }) });
    await client.fetchQuery({ ...checklistQuery, queryFn: async () => ({ steps: [] }) });
    await client.fetchQuery({
      ...meQuery,
      queryFn: async () => ({
        display_name: "   ",
        employee_org_unit: "HR Team",
        employee_position: "Manager",
        tenant: { name: "Corp", phase: "OPERATING" },
      }),
    });
    vi.stubGlobal("document", { documentElement: { dataset: { experience: "console" } } });
    const ConsolePack = (await loadPack()).default;
    vi.unstubAllGlobals();

    const whitespaceNameHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConsolePack><h1>{t("app.name")}</h1></ConsolePack>
      </QueryClientProvider>,
    );
    expect(whitespaceNameHtml).toContain(t("account.name.unset"));
    expect(whitespaceNameHtml).not.toContain(`${t("account.name.unset")} · HR Team`);

    await client.fetchQuery({
      ...meQuery,
      staleTime: 0,
      queryFn: async () => ({
        display_name: "Seoyeon Moon",
        employee_org_unit: "   ",
        employee_position: "  ",
        tenant: { name: "Corp", phase: "OPERATING" },
      }),
    });
    const whitespaceRoleHtml = renderToStaticMarkup(
      <QueryClientProvider client={client}>
        <ConsolePack><h1>{t("app.name")}</h1></ConsolePack>
      </QueryClientProvider>,
    );
    expect(whitespaceRoleHtml).toContain(">Seoyeon Moon</bdi>");
    expect(whitespaceRoleHtml).not.toContain("Seoyeon Moon ·");
    locationState.pathname = "/account";
    const acctConsole = renderToStaticMarkup(<QueryClientProvider client={client}><ConsolePack><h1>{t("shell.profile")}</h1></ConsolePack></QueryClientProvider>);
    const statusArea = acctConsole.split(`aria-label="${t("shell.status.label")}"`)[1] ?? "";
    expect(statusArea).toContain(t("shell.profile"));
    expect(statusArea).not.toContain(t("shell.account"));
    expect(renderToStaticMarkup(<QueryClientProvider client={client}><Shell /></QueryClientProvider>)).toContain(t("shell.account"));
  } finally {
    locationState.pathname = "/people";
    vi.stubGlobal("document", origDocument);
    session.set(null);
    client.clear();
  }
});
