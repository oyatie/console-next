// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { go, kstDate, registerEmployee, routeReady } from "./flows";
import { SETUP_DEPARTMENT, setupCompany, tenantBeforeSetup } from "./setup-flows";

const cases = [
  { path: "/", read: "/api/v1/me/action-inbox", button: /^기다리는 중/ },
  { path: "/statutory?tab=register", read: "/api/v1/statutory/workplaces", date: true },
  { path: "/statutory", read: "/api/v1/statutory/insurance-filings", button: "처리 내역" },
  { path: "/statutory", read: "/api/v1/statutory/insurance-filings", search: "이름·사번 검색" },
  { path: "/statutory?tab=register&site=$site", read: "/api/v1/statutory/worker-register", date: true },
  { path: "/attendance?tab=day", read: "/api/v1/attendance/days", button: "이전 날" },
  { path: "/attendance?tab=day", read: "/api/v1/attendance/days", button: "확인 필요만" },
  { path: "/attendance?tab=month", read: "/api/v1/attendance/month", button: "이전 달" },
  { path: "/attendance?tab=schedule", read: "/api/v1/attendance/schedule/calendar", button: "이전 달" },
  { path: "/attendance?tab=schedule&view=holidays", read: "/api/v1/attendance/holidays", button: "이전 연도" },
  { path: "/attendance?tab=schedule&view=public", read: "/api/v1/attendance/holidays", button: "이전 연도" },
  { path: "/org/entities", read: "/api/v1/legal-entities", date: true },
  { path: "$entity", read: "$entityRead", date: true },
  { path: "/org", read: "/api/v1/org-structure", date: true },
  { path: "/org/changes", read: "/api/v1/org-changes", button: /^완료 / },
  { path: "/people", read: "/api/v1/employees", search: "이름 또는 사번" },
  { path: "/people?view=accounts", read: "/api/v1/directory/people", search: "계정 이름·사번 검색", submit: "계정 검색" },
  { path: "/people?view=accounts", read: "/api/v1/directory/people", button: "비활성 계정 포함" },
  { path: "/access/grants", read: "/api/v1/access/grants", select: "역할" },
  { path: "/people/exits", read: "/api/v1/hr/exit-cases", search: "이름 또는 사번" },
];

test.describe("read boundaries keep chrome, previous content and keyboard focus", () => {
  test.describe.configure({ mode: "default" });
  let admin: Page;
  let entity: string;
  let site: string;
  let role: { id: string; name_ko: string };
  let employee: string;
  let exit: string;
  let headers: { authorization: string };
  test.beforeAll(async ({ browser }) => {
    test.setTimeout(300_000);
    const tenant = await tenantBeforeSetup(browser, `refetch-${test.info().workerIndex}`, "읽기 유지", false, "none");
    admin = tenant.admin;
    await tenant.exec.context().close();
    await setupCompany(admin, "읽기 유지 법인");
    entity = new URL(admin.url()).pathname;
    await registerEmployee(admin, { name: "읽기 유지 직원", hired: kstDate(-30), unit: SETUP_DEPARTMENT });
    employee = new URL(admin.url()).pathname.split("/").pop()!;
    const workplaces = admin.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/statutory/workplaces" && r.ok());
    await go(admin, "/statutory?tab=register");
    const sites = await (await workplaces).json();
    expect(sites.length).toBeGreaterThan(0);
    site = sites[0].id;
    const roles = admin.waitForResponse(r => new URL(r.url()).pathname === "/api/v1/access/roles" && r.ok());
    await go(admin, "/access/grants");
    headers = { authorization: (await roles).request().headers()["authorization"]! };
    const created = await admin.request.post("/api/v1/access/roles", { headers, data: { name_ko: "읽기 유지 역할", status: "ACTIVE", lines: [{ domain: "org", levels: ["view"] }] } });
    expect(created.status()).toBe(201);
    role = await created.json();
  });
  test.afterAll(async () => { await admin?.context().close(); });

  for (const row of cases) {
    const resolve = (value: string) => value.replace("$entityRead", `/api/v1/legal-entities/${entity.split("/").pop()}`).replace("$entity", entity).replace("$site", site).replace("$role", role.id);
    const name = `${row.path} ${"date" in row ? "date" : "search" in row ? "search" : "select" in row ? row.select : row.button}`;
    for (const first of [true, false]) test(`${name}: held ${first ? "first load" : "refetch"}`, async () => {
      const page = await admin.context().newPage();
      const read = resolve(row.read);
      let held = first;
      let release!: () => void;
      const wait = new Promise<void>(done => { release = done; });
      let requested = false;
      await page.route("**/api/**", async route => {
        if (route.request().method() !== "GET" || new URL(route.request().url()).pathname !== read) return route.continue();
        if (held && (!("select" in row) || first || new URL(route.request().url()).searchParams.get("role_id") === role.id)) { requested = true; await wait; }
        if (row.path === "/") {
          const response = await route.fetch();
          const data = await response.json();
          // Expose the real inbox's filter chrome even when this new tenant has no waiting work.
          return route.fulfill({ response, json: { ...data, setup: null, has_work: true, available_filters: ["turn", "waiting"] } });
        }
        await route.continue();
      });
      try {
        const answered = first ? undefined : page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === read && r.ok());
        await page.goto(resolve(row.path));
        const main = page.getByRole("main");
        await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible({ timeout: 1500 });
        if (first) {
          await expect.poll(() => requested).toBe(true);
          await expect(main.locator('[aria-busy="true"]').last()).toBeVisible({ timeout: 1500 });
          await expect(main.locator("[data-read-layout]").last()).toBeVisible({ timeout: 1500 });
          return;
        }
        await (await answered)?.finished();
        await routeReady(page);
        await expect(main.locator("[data-read-region]").last()).toBeAttached();
        await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
        const regions = await main.locator("[data-read-region]").elementHandles();
        const content = await Promise.all(regions.map(region => region.$(":scope > *")));
        const chrome = await main.locator('[role="tablist"]:visible, [role="toolbar"]:visible').elementHandles();
        const heading = main.getByRole("heading", { level: 1 }).first();
        const mountedHead = await heading.elementHandle();
        held = true;
        let control: Locator;
        if ("date" in row) {
          const field = main.getByRole("textbox", { name: /^기준일/ });
          await field.fill(kstDate(-1));
          await field.press("Tab");
          control = main.getByRole("button", { name: "달력 열기", exact: true }).first();
        } else if ("search" in row) {
          const field = main.getByRole("textbox", { name: row.search }).or(main.getByRole("searchbox", { name: row.search }));
          await field.fill("읽기 유지");
          control = "submit" in row ? main.getByRole("button", { name: row.submit, exact: true }) : field;
          await control.focus();
          await control.press("Enter");
        } else if ("select" in row) {
          control = main.getByRole("button", { name: /역할/ });
          await control.click();
          await page.getByRole("option", { name: role.name_ko, exact: true }).click();
        } else {
          control = main.getByRole("button", { name: row.button, exact: typeof row.button === "string" });
          await control.focus();
          await control.press("Enter");
        }
        await expect.poll(() => requested).toBe(true);
        await expect(main.locator('[data-read-region][aria-busy="true"]').last()).toBeVisible();
        const index = (await Promise.all(regions.map(region => region.evaluate(el => el instanceof Element && el.isConnected && el.getAttribute("aria-busy") === "true")))).findIndex(Boolean);
        expect(index).toBeGreaterThanOrEqual(0);
        let intact = true;
        const started = Date.now();
        await expect.poll(async () => {
          intact &&= await control.count() === 1 && await control.evaluate(el => el.isConnected && document.activeElement === el);
          intact &&= await mountedHead!.evaluate(el => el.isConnected);
          for (const bar of chrome) intact &&= await bar.evaluate(el => el instanceof Element && el.isConnected && el.getClientRects().length > 0);
          intact &&= await regions[index]!.evaluate(el => el.isConnected);
          if (content[index]) intact &&= await content[index]!.evaluate(el => el.isConnected);
          intact &&= await main.locator("[data-read-layout]").count() === 0;
          return Date.now() - started;
        }, { intervals: [100, 200, 250] }).toBeGreaterThanOrEqual(1500);
        expect(intact).toBe(true);
        await expect(control).toBeFocused();
      } finally {
        held = false; release();
        await page.unrouteAll({ behavior: "wait" });
        await page.close();
      }
    });
  }

  for (const tab of ["day", "month"]) for (const status of [403, 404]) test(`${tab}: ${status} scope refusal keeps the workplace recovery picker`, async () => {
    const page = await admin.context().newPage();
    const unknown = randomUUID();
    await page.route("**/api/v1/attendance/**", route => {
      const url = new URL(route.request().url());
      return url.searchParams.get("workplace_id") === unknown
        ? route.fulfill({ status, json: { error: { code: status === 403 ? "out_of_scope" : "not_found" } } })
        : route.continue();
    });
    try {
      await page.goto(`/attendance?tab=${tab}&wp=${unknown}`);
      const main = page.getByRole("main");
      await expect(main.getByText(status === 403 ? "이 화면에 접근 권한이 없습니다" : "기록을 찾을 수 없습니다", { exact: true })).toBeVisible();
      const picker = main.getByRole("combobox", { name: "단위" });
      await expect(picker).toBeVisible();
      await expect(picker).toHaveValue(unknown);
      await expect(main.getByRole("toolbar")).toHaveCount(0);
      const recovered = page.waitForResponse(r => new URL(r.url()).pathname === `/api/v1/attendance/${tab === "day" ? "days" : "month"}` && !new URL(r.url()).searchParams.has("workplace_id") && r.ok());
      await picker.selectOption("");
      await recovered;
      await expect(main.getByRole("toolbar")).toBeVisible();
      await expect(main.getByText("이 화면에 접근 권한이 없습니다", { exact: true })).toHaveCount(0);
    } finally { await page.close(); }
  });

  for (const row of [
    { path: "/people?view=accounts", read: "/api/v1/directory/people" },
    { path: "/org/entities", read: "/api/v1/legal-entities" },
    { path: "/attendance?tab=day", read: "/api/v1/attendance/days" },
    { path: "/attendance?tab=month", read: "/api/v1/attendance/month" },
    { path: "/statutory?tab=register", read: "/api/v1/statutory/workplaces" },
    { path: "$entity", read: "$entityRead", record: true },
    { path: "/people/$employee/identifiers", read: "/api/v1/employees/$employee", record: true },
    { path: "/people/exits/$exit", read: "/api/v1/hr/exit-cases/$exit", record: true },
  ]) for (const status of "record" in row ? [403, 404] : [403]) test(`${row.path}: refetch into ${status} removes refused controls and record facts`, async () => {
    if (row.path.includes("$exit") && !exit) {
      const reported = await admin.request.post("/api/v1/hr/exit-cases", { headers: { ...headers, "Idempotency-Key": randomUUID() }, data: { employee_id: employee, effective_exit_date: kstDate(30), site_manager_note: "읽기 유지 확인" } });
      expect(reported.status()).toBe(201);
      exit = (await reported.json()).id;
    }
    const resolve = (value: string) => value.replace("$entityRead", `/api/v1/legal-entities/${entity.split("/").pop()}`).replace("$entity", entity).replace("$employee", employee).replace("$exit", exit);
    const page = await admin.context().newPage();
    const read = resolve(row.read);
    let refused = false;
    let release!: () => void;
    const reset = new Promise<void>(done => { release = done; });
    // A stream reset re-reads mounted queries through the production invalidation path.
    await page.route("**/api/v1/events", async route => { await reset; await route.fulfill({ contentType: "text/event-stream", body: "event: reset\ndata: {}\n\n" }); });
    await page.route("**/api/**", route => route.request().method() === "GET" && new URL(route.request().url()).pathname === read && refused ? route.fulfill({ status, json: { error: { code: status === 403 ? "forbidden" : "not_found", message: "lost" } } }) : route.fallback());
    try {
      const answered = page.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname === read && r.ok());
      await page.goto(resolve(row.path));
      await (await answered).finished();
      await routeReady(page);
      const main = page.getByRole("main");
      await expect(main.locator("[data-read-region]").last()).toBeAttached();
      const head = main.getByRole("heading", { level: 1 }).first();
      await expect(head).toBeVisible();
      const mountedHead = await head.elementHandle();
      if ("record" in row) expect(await main.locator("a[href]").count()).toBeGreaterThan(0);
      refused = true;
      release();
      if (status === 403) await expect(main.getByRole("region", { name: "이 화면에 접근 권한이 없습니다" })).toBeVisible({ timeout: 15_000 });
      else await expect(main.getByText("기록을 찾을 수 없습니다", { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(main.locator("form")).toHaveCount(0);
      if (row.path === "/people?view=accounts") {
        await expect(main.getByRole("button", { name: "직원", exact: true })).toHaveCount(0);
        await expect(main.getByRole("button", { name: "계정", exact: true })).toHaveCount(0);
      }
      await expect(main.getByRole("tablist")).toHaveCount(0);
      await expect(main.getByRole("toolbar")).toHaveCount(0);
      await expect(main.getByRole("textbox").or(main.getByRole("searchbox"))).toHaveCount(0);
      if ("record" in row) {
        expect(await mountedHead!.evaluate(el => el.isConnected)).toBe(false);
        await expect(main.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(main.getByRole("link", { name: /읽기 유지 직원/ })).toHaveCount(0);
      } else await expect(head).toBeVisible();
      await expect(page.getByRole("navigation", { name: "주 메뉴" })).toBeVisible();
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await page.close();
    }
  });
});
