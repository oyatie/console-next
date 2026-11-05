// SPDX-License-Identifier: LicenseRef-Proprietary
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { firstSignIn, go, registerEmployee, vendorPage } from "../flows";
import { inviteAccount } from "../access-flows";
import { bearerOf } from "../helpers/api";
import { SETUP_DEPARTMENT, startOperations, tenantInSetup } from "../setup-flows";
import { classifyWrite, probeWrites } from "./write-probe";

const census = JSON.parse(execFileSync("node", ["scripts/d10-census.mjs"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })) as { operation: string }[];
const selfService = JSON.parse(readFileSync(new URL("./self-service.json", import.meta.url), "utf8")) as Record<string, string>;

test("every census write is measured with no grant and an ops control", { tag: ["@negative", "@write-probe"] }, async ({ browser, request }, info) => {
  test.setTimeout(600_000);
  expect(census.length).toBeGreaterThan(0);
  expect(new Set(census.map(r => r.operation)).size).toBe(census.length);
  for (const [operation, reason] of Object.entries(selfService)) {
    expect(census.some(r => r.operation === operation), `stale self-service exception: ${operation}`).toBe(true);
    expect(reason.trim(), operation).not.toBe("");
  }
  const { admin } = await tenantInSetup(browser, "write-refusals", "쓰기 권한 검증상사");
  await registerEmployee(admin, { name: "가상 직원", unit: SETUP_DEPARTMENT });
  await startOperations(admin);
  const viewer = await firstSignIn(browser, await inviteAccount(admin, "무권한 검증인", "none"));
  const capture = async (page: Page) => {
    const bearer = bearerOf(page);
    await page.reload();
    await go(page, "/");
    await expect.poll(bearer).not.toBe("");
    return bearer();
  };
  const opsToken = await capture(admin), viewerToken = await capture(viewer);
  const telemetry = await request.post("/api/v1/console/telemetry/route", {
    headers: { authorization: viewerToken },
    data: { event_kind: "route_selection", route_surface: "console", route_path: "/", release_cycle: "test" },
  });
  expect(telemetry.status(), "route telemetry is absent from the release build").toBe(404);
  await telemetry.dispose();
  const platform = await vendorPage(browser);
  const platformToken = bearerOf(platform);
  await platform.reload();
  await expect.poll(platformToken).not.toBe("");
  const ids: Record<string, string> = {};
  for (const collection of ["legal-entities", "workplaces", "org-units", "employees", "access/roles"]) {
    const response = await request.get(`/api/v1/${collection}`, { headers: { authorization: opsToken } });
    expect(response.status(), collection).toBe(200);
    type Item = { id: string; kind?: string };
    const body = await response.json() as { items: Item[] } | Item[];
    const items = Array.isArray(body) ? body : body.items;
    const item = collection === "org-units" ? items.find(r => r.kind === "DEPARTMENT") : items[0];
    expect(item?.id, `${collection} fixture`).toBeTruthy();
    ids[collection.split("/").at(-1)!] = item!.id;
    await response.dispose();
  }
  // The request fixture has no browser cookies: auth self-service cannot rotate the pages' sessions.
  const send = (token: string) => (path: string, method: string) => request.fetch(path, {
    method, headers: { authorization: token, "Idempotency-Key": crypto.randomUUID() }, data: {},
    failOnStatusCode: false, maxRedirects: 0, maxRetries: 0, timeout: 10_000,
  });
  const faults: string[] = [];
  let controls = 0;
  for await (const { operation, result, control } of probeWrites(census.map(r => r.operation), ids, send(viewerToken), send(opsToken))) {
    let ops_http_status: number | null = null, ops_support_ref: string | null = null;
    if (result.http_status === 403 && result.support_ref) {
      try {
        const lookup = await request.get(`/api/platform/support-references/${encodeURIComponent(result.support_ref)}`, {
          headers: { authorization: platformToken() }, failOnStatusCode: false, timeout: 10_000,
        });
        ops_http_status = lookup.status();
        const context = await lookup.json().catch(() => null) as { support_ref?: string } | null;
        ops_support_ref = context?.support_ref ?? null;
        await lookup.dispose();
      } catch {
        ops_http_status = 0;
      }
    }
    const self_service_reason = selfService[operation];
    const { status, controlValid, fault } = classifyWrite(result, control, self_service_reason);
    if (controlValid && !self_service_reason) controls++;
    await info.attach("write-probe", { contentType: "application/json", body: Buffer.from(JSON.stringify({
      operation, principal: "no-grant", ...result, status, ops_http_status, ops_support_ref, control_http_status: control.http_status,
      control_code: control.code, self_service_reason,
    })) });
    if (fault) faults.push(`${operation}: ${fault}`);
  }
  expect(controls, "ops must reach at least one protected write with the identical request").toBeGreaterThan(0);
  expect(faults, "unknown responses remain unscored; accepted writes and harness faults fail").toEqual([]);
});
