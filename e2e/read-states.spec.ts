// SPDX-License-Identifier: LicenseRef-Proprietary
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { bootKo } from "../packages/i18n/src/catalogs/boot";
import { ko } from "../packages/i18n/src/catalogs/ko";
import { expectAccessible, expectAxe } from "./a11y";
import { apiOf, bearerOf } from "./helpers/api";
import { redirectTargets, routeList } from "./helpers/route-list";
import { readRequirement } from "../apps/web/src/routes/route-reads";
import { todayKst } from "../apps/web/src/lib/pure/today";
import { go, routeReady, vendorPage } from "./flows";
import { expectStable } from "./stability";
import { setupCompany, startOperations, tenantBeforeSetup } from "./setup-flows";

const record = randomUUID();
const routes = [
  { path: "/", read: "/api/v1/me/action-inbox" },
  ...["/org/entities", "/org/entities/new"].map(path => ({ path, read: "/api/v1/legal-entities" })),
  { path: `/org/entities/${record}`, read: `/api/v1/legal-entities/${record}` },
  ...["wp-create", "wp-edit", "wp-close", "wp-move"].map(act => ({ path: `/org?act=${act}`, read: "/api/v1/org-structure" })),
  { path: "/people", read: "/api/v1/employees" },
  { path: "/people?view=accounts", read: "/api/v1/directory/people" },
  { path: "/people/import", read: "/api/v1/access/me" },
  { path: "/people/job-titles", read: "/api/v1/job-titles" },
  { path: "/people/unplaced", read: "/api/v1/employees/import/unplaced" },
  ...["/org/paste", "/org/import"].map(path => ({ path, read: "/api/v1/org-structure" })),
  { path: `/people/${record}?act=menu`, read: `/api/v1/employees/${record}` },
  { path: `/people/exits/${record}`, read: `/api/v1/hr/exit-cases/${record}` },
  { path: `/org/changes/${record}`, read: `/api/v1/org-changes/${record}` },
  { path: `/people/notices/${record}`, read: `/api/v1/appointment-notices/${record}` },
  { path: `/access/roles/${record}`, read: `/api/v1/access/roles/${record}` },
  { path: `/access/people/${record}`, read: `/api/v1/access/accounts/${record}/effective` },
  { path: `/people/${record}/identifiers`, read: `/api/v1/employees/${record}` },
  { path: "/attendance", read: "/api/v1/attendance/month" },
  { path: "/statutory", read: "/api/v1/statutory/workplaces" },
  ...["/people/grid", "/people/bulk", "/people/renew"].map(path => ({ path, read: "/api/v1/org-units" })),
  { path: "/people/numbering", read: "/api/v1/employee-number-rules" },
  { path: "/access/roles/new", read: "/api/v1/access/catalog" },
  { path: "/access/grants/bulk", read: "/api/v1/access/roles" },
  { path: "/platform", read: "/api/platform/orgs" },
];
const details = routes.filter(({ path }) => path.includes(record));
const reference = "state-regression-reference";
const failure = (status: number) => ({ status, json: { error: { code: status === 403 ? "forbidden" : status === 404 ? "not_found" : "service_unavailable", message: "읽기 요청을 처리하지 못했습니다.", operation_id: reference } } });

test.describe("route requirements with a real grantless account", () => {
  test.describe.configure({ mode: "default" });
  let admin: Page;
  let reader: Page;
  let token: ReturnType<typeof bearerOf>;
  test.beforeAll(async ({ browser }) => {
    ({ admin, exec: reader } = await tenantBeforeSetup(browser, `route-refusal-${test.info().workerIndex}`, "권한 없는 화면", false, "none"));
    token = bearerOf(reader);
    await reader.reload();
    await routeReady(reader);
    await expect.poll(token).not.toBe("");
    const me = await (await apiOf(reader, token)("/access/me")).json();
    expect(me.is_ops).toBe(false);
    expect(me.entries).toEqual([]);
  });
  test.afterAll(async () => { await Promise.all([admin?.context().close(), reader?.context().close()]); });

  for (const { path, reads } of routeList.filter(route => route.reads.length)) {
    test(`${path}: the server refuses the protected read`, async () => {
      for (const read of reads) {
      const endpoint = read.replace(/\$[^/]+/g, record).replace("/api/v1", "");
      const query = read.endsWith("/attendance/month") ? `?month=${todayKst().slice(0, 7)}` : read.endsWith("/attendance/days") ? `?date=${todayKst()}` : "";
      const response = await apiOf(reader, token)(`${endpoint}${query}`);
      expect(response.status(), read).toBe(403);
      expect((await response.json()).error.code).toBeTruthy();
      }
    });
    for (const width of [1440, 390]) for (const theme of ["light", "dark"]) {
      test(`${path}: one refusal, no page controls at ${width} ${theme}`, async () => {
        const page = await reader.context().newPage();
        try {
          await page.setViewportSize({ width, height: 900 });
          await page.addInitScript(value => { localStorage.setItem("console.theme", value); }, theme);
          await go(page, path.replace(/\$[^/]+/g, record), path in redirectTargets);
          const main = page.getByRole("main");
          const card = main.getByRole("region", { name: bootKo["common.denied.title.plain"], exact: true });
          await expect(card).toHaveCount(1);
          await expect(card.getByRole("button", { name: bootKo["common.denied.request"], exact: true })).toBeVisible();
          const permission = await card.locator(".state > .muted").innerText();
          const need = readRequirement(path as Parameters<typeof readRequirement>[0]);
          const required = "domain" in need ? [need] : need.allOf;
          for (const entry of required) {
            expect(permission).toContain(ko[`accessCodes.domain.${entry.domain}` as keyof typeof ko]);
            expect(permission).toContain(ko[`accessCodes.level.${entry.level}` as keyof typeof ko]);
          }
          expect(await main.locator("button, a, input, select, textarea, [role=tab]").evaluateAll((elements, label) => elements.filter(element => element.closest('section[aria-label]')?.getAttribute("aria-label") !== label).length, bootKo["common.denied.title.plain"])).toBe(0);
          expect(await main.innerText()).toBe(await card.innerText());
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          if (["/people", "/org/changes", "/access/roles"].includes(path)) await expectAxe(page, `${path} refused at ${width} ${theme}`);
        } finally { await page.close(); }
      });
    }
  }

  for (const path of [`/people/${record}`, `/org/entities/${record}`]) {
    test(`ops ${path.replace(record, "$id")}: an absent record stays not-found`, async () => {
      await go(admin, path);
      await expect(admin.getByRole("heading", { name: bootKo["common.read.notFound.title"], exact: true })).toBeVisible();
      await expect(admin.getByRole("button", { name: bootKo["common.denied.request"], exact: true })).toHaveCount(0);
    });
  }
});

test.describe("one state contract across console routes", () => {
  test.describe.configure({ mode: "default" });
  let admin: Page;
  let exec: Page;
  let operator: Page;
  const context = (path: string) => path === "/platform" ? operator.context() : admin.context();
  test.beforeAll(async ({ browser }) => {
    ({ admin, exec } = await tenantBeforeSetup(browser, `readstates-${test.info().workerIndex}`, "상태 확인", false, "none"));
    operator = await vendorPage(browser);
  });
  // The vendor page is shared by the worker's other specs.
  test.afterAll(async () => { await Promise.all([admin?.context().close(), exec?.context().close()]); });

  for (const width of [1440, 390]) test(`account-name font swap keeps top-bar controls in place at ${width}px`, async () => {
    const page = await admin.context().newPage();
    await page.setViewportSize({ width, height: 900 });
    try {
      await page.goto("/attendance");
      await routeReady(page);
      const positions = await page.locator(".top").evaluate(async top => {
        await document.fonts.ready;
        const name = top.querySelector<HTMLElement>(".top__name span")!;
        const rects = () => [...top.querySelectorAll("button, a, select")].map(control => control.getBoundingClientRect().toJSON());
        name.style.fontFamily = "sans-serif";
        const fallback = rects();
        name.style.removeProperty("font-family");
        return { fallback, loaded: rects() };
      });
      expect(positions.loaded).toEqual(positions.fallback);
      if (width === 390) {
        // On a phone the name may shorten, but it never draws over the controls beside it.
        const overlaps = await page.locator(".top").evaluate(top => {
          const name = top.querySelector<HTMLElement>(".top__name span")!.getBoundingClientRect();
          return [...top.querySelectorAll<HTMLElement>("button, a, select")]
            .filter(control => !control.contains(top.querySelector(".top__name span")))
            .map(control => control.getBoundingClientRect())
            .filter(r => r.width > 0 && r.left < name.right && name.left < r.right && r.top < name.bottom && name.top < r.bottom).length;
        });
        expect(overlaps).toBe(0);
      }
      if (width === 1440) {
        // The reserved slot is a minimum, never a cap: the account name is shown whole.
        expect(await page.locator(".top__name span").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const name = page.locator(".top__name");
        const wide = await name.boundingBox();
        await page.setViewportSize({ width: 1280, height: 900 });
        expect((await name.boundingBox())!.width).toBe(wide!.width);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    } finally { await page.close(); }
  });

  for (const width of [1440, 390]) for (const path of ["/org/entities/new", "/people/new"]) {
    test(`${path}: first-visit setup band leaves creation controls clear at ${width}px`, async () => {
      const page = await admin.context().newPage();
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        for (const key of Object.keys(localStorage)) if (key.startsWith("console.phase.")) localStorage.removeItem(key);
      });
      try {
        await page.goto(path);
        await routeReady(page);
        await expect(page.getByText("설정 단계 · 운영 시작 전", { exact: true })).toHaveCount(0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        const commit = path === "/org/entities/new" ? page.getByRole("button", { name: "다음", exact: true }) :
          page.getByRole("dialog", { name: "직원 등록" }).getByRole("button", { name: /^직원 등록 1명 적용 · 다음 직원/ });
        await expect(commit).toBeInViewport();
        expect(await commit.evaluate(button => {
          const rect = button.getBoundingClientRect();
          return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        })).toBe(true);
      } finally { await page.close(); }
    });
  }

  for (const { path, read } of routes) {
    test(`${path.replaceAll(record, "$id")}: held reads and 503 keep the shell, with a retry and reference`, async () => {
      const page = await context(path).newPage();
      let held = true;
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      await page.route("**/api/**", async route => {
        if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== read) return route.continue();
        if (held) await wait;
        await route.fulfill(failure(503));
      });
      try {
        const requested = page.waitForRequest(request => request.method() === "GET" && new URL(request.url()).pathname === read);
        await page.goto(path);
        await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible({ timeout: 1500 });
        await requested;
        await expect(page.getByRole("main").locator('[aria-busy="true"]').last()).toBeVisible({ timeout: 1500 });
        await expect(page.getByRole("main").locator("[data-read-layout]").last()).toBeVisible({ timeout: 1500 });
        held = false;
        release();
        await expect(page.getByRole("main").getByText("불러오지 못했습니다", { exact: true }).first()).toBeVisible({ timeout: 15_000 });
        await expect(page.getByRole("main").getByRole("button", { name: "다시 불러오기", exact: true }).first()).toBeVisible();
        await expect(page.getByRole("main").getByText(reference, { exact: true }).first()).toBeVisible();
        await expect(page.getByText("화면을 표시하지 못했습니다", { exact: true })).toHaveCount(0);
        await expectAccessible(page, `${path} read failure`);
      } finally {
        held = false;
        release();
        await page.unrouteAll({ behavior: "wait" });
        await page.close();
      }
    });

    test(`${path.replaceAll(record, "$id")}: a failed cold refresh stays inside the shell and recovers`, async () => {
      const page = await context(path).newPage();
      const protectedReads: string[] = [];
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (["/api/v1/me/authz", "/api/v1/support-sessions/active"].includes(path)) protectedReads.push(path);
      });
      await page.route("**/api/v1/auth/token/refresh", route => route.fulfill(failure(503)));
      await page.goto(path);
      await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible({ timeout: 1500 });
      await expect(page.getByRole("main").getByText("불러오지 못했습니다", { exact: true })).toBeVisible();
      await expect(page.getByText("화면을 표시하지 못했습니다", { exact: true })).toHaveCount(0);
      expect(protectedReads).toEqual([]);
      await page.unroute("**/api/v1/auth/token/refresh");
      const restored = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/auth/token/refresh" && response.status() === 200);
      await page.getByRole("button", { name: "다시 불러오기", exact: true }).click();
      await restored;
      await expect(page.getByRole("main").getByText("불러오지 못했습니다", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
      await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
      await expect(page.getByRole("main").locator('[aria-busy="true"]')).toHaveCount(0, { timeout: 15_000 });
      await page.close();
    });
  }

  for (const { path, read } of details) test(`${path.replaceAll(record, "$id")}: an unknown id is not a load failure`, async () => {
    const page = await context(path).newPage();
    // Keep shared references and grants real; only this record's read is missing.
    await page.route("**/api/**", route => route.request().method() === "GET" && new URL(route.request().url()).pathname === read ? route.fulfill(failure(404)) : route.continue());
    await page.goto(path);
    await expect(page.getByRole("main").getByText("기록을 찾을 수 없습니다", { exact: true }).first()).toBeVisible();
    const list = path.startsWith("/org/entities") ? "/org/entities" : path.startsWith("/org/changes") ? "/org/changes" : path.startsWith("/people/exits") ? "/people/exits" : path.startsWith("/people/notices") ? "/people/notices" : path.startsWith("/access/roles") ? "/access/roles" : path.startsWith("/access/people") ? "/access/grants" : "/people";
    await expect(page.getByRole("main").locator(`a[href="${list}"]`).first()).toBeVisible();
    await expect(page.getByRole("main").getByText("불러오지 못했습니다", { exact: true })).toHaveCount(0);
    await page.close();
  });

  for (const { path, read } of routes.filter(route => route.path !== "/")) test(`${path.replaceAll(record, "$id")}: a refusal names who can grant access`, async () => {
    const page = await context(path).newPage();
    await page.route("**/api/**", route => route.request().method() === "GET" && new URL(route.request().url()).pathname === read ? route.fulfill(failure(403)) : route.continue());
    await page.goto(path);
    const main = page.getByRole("main");
    await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
    await expect(main.locator("form")).toHaveCount(0);
    await expect(main.getByRole("tablist")).toHaveCount(0);
    await expect(main.getByText("forbidden", { exact: true })).toBeVisible();
    await expect(main.getByText("이유 보기", { exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: "내 권한 보기", exact: true })).toHaveCount(0);
    await main.getByText("이유 보기", { exact: true }).click();
    await expect(main.getByText("forbidden", { exact: true })).toBeVisible();
    await expect(main.getByText(reference, { exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "권한 요청", exact: true })).toBeVisible();
    await expect(page.getByRole("main").getByText(path === "/platform" ? bootKo["common.denied.granters.unavailable"] : "권한을 부여할 수 있는 담당자").first()).toBeVisible();
    await expect(page.getByText("일치하는 계정이 없습니다", { exact: true })).toHaveCount(0);
    await page.close();
  });

  for (const path of ["/", "/people", "/attendance", "/people/import", "/org/entities/new", "/access/roles/new", "/access/grants/bulk", "/people/grid", "/people/bulk", "/people/renew", "/people/numbering", "/org/paste", "/org/import", "/platform"]) test(`${path.replaceAll(record, "$id")}: a real account with no grant sees its honest state`, async () => {
    await go(exec, path);
    if (path === "/") {
      await expect(exec.getByText("이 계정으로 처리할 업무가 없습니다", { exact: true })).toBeVisible();
      await expect(exec.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toHaveCount(0);
    } else if (path === "/platform") {
      await expect(exec.getByRole("heading", { name: "페이지를 찾을 수 없습니다", exact: true })).toBeVisible();
    } else await expect(exec.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible();
    await expect(exec.getByText("일치하는 계정이 없습니다", { exact: true })).toHaveCount(0);
  });

  test("offline keeps a loaded region visibly marked", async () => {
    const page = await admin.context().newPage();
    await go(page, "/people/job-titles");
    await expect(page.getByRole("heading", { name: "직위 목록" })).toBeVisible();
    await admin.context().setOffline(true);
    try {
      await expect(page.getByRole("main").getByText(/오프라인/).first()).toBeVisible();
      await expect(page.getByRole("heading", { name: "직위 목록" })).toBeVisible();
      await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
    } finally { await admin.context().setOffline(false); await page.close(); }
  });

  test("an unrelated held checklist leaves people usable", async () => {
    await go(admin, "/people");
    const page = await admin.context().newPage();
    await page.route("**/api/v1/onboarding/checklist", () => {});
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: "직원", exact: true }).first()).toBeVisible();
    await page.close();
  });

  test("unpublished consent sends the account to actionable setup", async () => {
    const page = await admin.context().newPage();
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = async (...args) => {
        const response = await fetch(...args);
        if (new URL(response.url).pathname !== "/api/v1/auth/token/refresh" || !response.ok) return response;
        return new Response(JSON.stringify({ ...await response.json(), privacy_consent_accepted: false }), { status: response.status, headers: response.headers });
      };
    });
    await page.route("**/api/v1/onboarding/terms", route => route.fulfill({ status: 409, json: { error: { code: "terms_not_published", message: "unpublished" } } }));
    try {
      await page.goto("/people");
      await expect(page).toHaveURL(/\/setup-passkey$/);
      await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
    } finally { await page.close(); }
  });
  for (const status of [500, 503]) test(`Home keeps setup when /me/authz answers ${status}`, async () => {
    const page = await admin.context().newPage();
    await page.route("**/api/v1/me/authz", route => route.fulfill(failure(status)));
    try {
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible({ timeout: 1500 });
      const setup = page.getByRole("group", { name: "운영 준비", exact: true });
      await expect(setup).toBeVisible();
      await expect(setup.getByRole("link", { name: "법인 등록", exact: true }).first()).toBeVisible();
      await expect(page.getByText("처리하거나 확인할 일이 없습니다", { exact: true })).toHaveCount(0);
      await expectAccessible(page, `Home setup with authz ${status}`);
    } finally { await page.close(); }
  });

  test("Home keeps a setup skeleton while /me/authz is pending, then shows setup", async () => {
    const page = await admin.context().newPage();
    let release!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/v1/me/authz", async route => { await wait; await route.continue(); });
    try {
      await page.goto("/");
      await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible({ timeout: 1500 });
      await expect(page.getByRole("main").locator('[aria-busy="true"]').first()).toBeVisible({ timeout: 1500 });
      await expect(page.getByText("처리하거나 확인할 일이 없습니다", { exact: true })).toHaveCount(0);
      await expect(page.getByText("이 계정으로 처리할 업무가 없습니다", { exact: true })).toHaveCount(0);
      release();
      await expect(page.getByRole("group", { name: "운영 준비", exact: true })).toBeVisible();
      await expect(page.getByRole("main").locator('[aria-busy="true"]')).toHaveCount(0);
      await expectAccessible(page, "Home setup after pending authz");
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });

  test("Home keeps the no-work card for a grantless account in setup and live phases", async () => {
    test.setTimeout(300_000);
    const checklistReads: string[] = [];
    const collect = (request: import("@playwright/test").Request) => {
      if (new URL(request.url()).pathname === "/api/v1/onboarding/checklist") checklistReads.push(request.url());
    };
    exec.on("request", collect);
    try {
      for (const phase of ["setup", "live"]) {
        if (phase === "live") {
          await setupCompany(admin, "상태 확인 법인");
          await startOperations(admin);
        }
        await go(exec, "/");
        await expect(exec.getByText("이 계정으로 처리할 업무가 없습니다", { exact: true })).toBeVisible();
        await expect(exec.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toHaveCount(0);
        await expect(exec.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
        expect(checklistReads).toEqual([]);
        await expectAccessible(exec, `Home without grants: ${phase}`);
      }
    } finally { exec.off("request", collect); }
  });

});

test.describe("cold-load layout stability", () => {
  test.describe.configure({ mode: "default" });
  let admin: Page;
  let entityPath: string;
  let remembered: [string, string][];
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const tenant = await tenantBeforeSetup(browser, `coldstate-${test.info().workerIndex}`, "화면 안정성", false, "none");
    admin = tenant.admin;
    await tenant.exec.context().close();
    await setupCompany(admin, "화면 안정성 법인");
    entityPath = new URL(admin.url()).pathname;
    await startOperations(admin);
    remembered = await admin.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith("console.phase.")));
  });
  test.afterAll(async () => { await admin?.context().close(); });

  for (const path of ["/", "/people", "/people/job-titles", "/org/entities/$id"]) {
    for (const storage of ["last answer", "empty", "blocked"]) test(`${path}: cold restore with ${storage} keeps CLS within 0.02`, async () => {
      const page = await admin.context().newPage();
      await page.addInitScript(({ mode, remembered }) => {
        for (const key of Object.keys(localStorage)) if (key.startsWith("console.phase.")) localStorage.removeItem(key);
        if (mode === "last answer") for (const [key, value] of remembered) localStorage.setItem(key, value);
        if (mode === "blocked") Object.defineProperty(window, "localStorage", { get: () => { throw new Error("blocked storage"); } });
      }, { mode: storage, remembered });
      await page.setViewportSize({ width: 1440, height: 900 });
      for (const read of ["onboarding/checklist", "support-sessions/active"]) await page.route(`**/api/v1/${read}`, async route => {
        const response = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 600));
        await route.fulfill({ response });
      });
      const restored = page.waitForResponse(response => new URL(response.url()).pathname === "/api/v1/auth/token/refresh" && response.ok());
      const checklist = page.waitForResponse("**/api/v1/onboarding/checklist");
      try {
        await page.goto(path === "/org/entities/$id" ? entityPath : path);
        await Promise.all([restored, checklist]);
        await routeReady(page);
        await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
        await expect(page.getByRole("main").getByRole("heading", { level: 1 }).first()).toBeVisible();
        await expectStable(page, `${path}: cold restore (${storage})`);
      } finally {
        await page.unrouteAll({ behavior: "wait" });
        await page.close();
      }
    });
  }
});
