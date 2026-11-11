// SPDX-License-Identifier: LicenseRef-Proprietary
import { expect, test } from "@playwright/test";
import { fits } from "../a11y";
import { go, registerEmployee, routeReady } from "../flows";
import { apiOf, bearerOf } from "../helpers/api";
import { openTenant } from "../helpers/tenant";
import { SETUP_DEPARTMENT, setupCompany, startOperations } from "../setup-flows";
import { addDepartments } from "../structure-flows";
import { budget } from "./budget";
import { recordRoutes } from "./fixture";

test("synthetic tenant resolves every record route to saved content", { tag: "@perf" }, async ({ browser }) => {
  test.setTimeout(300_000);
  const admin = await openTenant(browser, "record-routes", "가상성능그룹");
  admin.setDefaultTimeout(30_000);
  const api = apiOf(admin, bearerOf(admin));
  await setupCompany(admin, "가상성능법인1", "가상사업장1");
  await go(admin, "/org");
  await addDepartments(admin, "가상사업장1", ["가상마지막부서"]);
  await registerEmployee(admin, { name: "가상직원", unit: SETUP_DEPARTMENT });
  const urls: Record<string, string> = { "/people/$id": new URL(admin.url()).pathname };
  await startOperations(admin);
  const entities = await (await api("/legal-entities")).json();
  urls["/org/entities/$id"] = `/org/entities/${entities.items[0].id as string}`;
  const units = await (await api("/org-units")).json();
  const department = units.items.find((unit: { name: string }) => unit.name === "가상마지막부서");
  const depts = Array<string>(budget.shape.workplaces + 1).fill(department.name);
  depts[0] = SETUP_DEPARTMENT;
  await recordRoutes(admin, urls, depts, department.id);
  try {
    const records = [
      ["/account/privacy/intake/$id", "/api/v1/privacy/rights-requests/", "가상 성능 측정용 열람 요구"],
      ["/approvals/$approvalId", "/api/v1/approvals/", "가상미래부서"],
      ["/payroll/employees/$employeeId", "/api/v1/payroll/employees/", "계약 임금"],
      ["/payroll/runs/$id", "/api/v1/payroll/runs/", "가상 성능 급여"],
    ] as const;
    for (const [route] of records) {
      expect(urls[route], route).toBeTruthy();
      expect(urls[route], route).not.toContain("$");
    }
    for (const [width, theme] of [[1440, "light"], [390, "dark"]] as const) {
      await admin.setViewportSize({ width, height: 900 });
      for (const [route, read, content] of records) {
        const loaded = admin.waitForResponse(r => r.request().method() === "GET" && new URL(r.url()).pathname.startsWith(read));
        await admin.goto(urls[route]!);
        expect((await loaded).status(), route).toBe(200);
        await routeReady(admin);
        await admin.locator("html").evaluate((el, value) => { el.dataset.theme = value; }, theme);
        await expect(admin.getByRole("heading", { level: 1 })).toHaveCount(1);
        await expect(admin.getByRole("main")).toContainText(content);
        await fits(admin, route);
        await admin.screenshot({ path: test.info().outputPath(`${route.split("/")[1]}-${route.split("/")[2]}-${width}-${theme}.png`), fullPage: true });
      }
    }
  } finally { await admin.context().close(); }
});
