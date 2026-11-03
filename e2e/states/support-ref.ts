// SPDX-License-Identifier: LicenseRef-Proprietary
import { readFileSync } from "node:fs";
import { expect as baseExpect, type Page, type TestInfo } from "@playwright/test";
import { routeList } from "../helpers/route-list";
import { authz, checklist, failure, id, modules, screenAccess, token, user } from "../mock/fixtures";
import { mockRoute } from "../mock/route";

type State = "failed" | "refused" | "no-reference";
type Part = "a" | "b";

// The inventory adds public routes; aliases share their simplest browser URL.
const inventory = process.env.E2E_MODULES_FILE
  ? JSON.parse(readFileSync(process.env.E2E_MODULES_FILE, "utf8")) as { modules: { routes: string[] }[]; floorplans?: Record<string, string | null> }
  : { modules: [], floorplans: {} };
const routes = [...new Set([...routeList.map(route => route.path), ...inventory.modules.flatMap(module => module.routes).filter(route => route.startsWith("/")).map(route => route.split("?")[0]!)])];
const middle = Math.ceil(routes.length / 2);
const parts = { a: routes.slice(0, middle), b: routes.slice(middle) };
const reference = id(99).replaceAll("-", "");
const raw = "서버 내부 진단 원문";
const expect = baseExpect.configure({ timeout: 20_000 });

const routeToken = (route: string) => {
  const pair = token();
  if (!route.startsWith("/platform")) return pair;
  const [header, body, signature] = pair.access_token.split(".");
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString()) as Record<string, unknown>;
  return { ...pair, access_token: `${header}.${Buffer.from(JSON.stringify({ ...claims, platform: true })).toString("base64url")}.${signature}` };
};

export const supportReferenceRoutes = (part: Part) => parts[part];
export const supportReferenceTitle = (route: string, state: State) => `${route}: ${state} support reference @ui-state`;

export function supportReferenceTest(route: string, state: State) {
  return async ({ page }: { page: Page }, info: TestInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark" });
    const body = failure(state === "refused" ? "forbidden" : "service_unavailable");
    body.error = { code: body.error.code, message: raw, ...(state === "no-reference" ? {} : { support_ref: reference }) };
    let injected = 0;
    // Catch every feature read first; later shell fixtures win by Playwright's registration order.
    await page.route("**/api/**", async request => {
      if (request.request().method() === "GET") injected++;
      await request.fulfill({ status: state === "refused" ? 403 : 503, json: body });
    });
    await mockRoute(page, "post", "/api/v1/auth/token/refresh", { status: 200, json: routeToken(route) });
    await mockRoute(page, "get", "/api/v1/users/me", { status: 200, json: user });
    await mockRoute(page, "get", "/api/v1/me/authz", { status: 200, json: authz });
    await mockRoute(page, "get", "/api/v1/onboarding/checklist", { status: 200, json: checklist });
    await mockRoute(page, "get", "/api/v1/onboarding/modules", { status: 200, json: modules.ready });
    await mockRoute(page, "get", "/api/v1/settings", { status: 200, json: { can_change: false, items: [] } });
    await mockRoute(page, "get", "/api/v1/access/me", request => ({ status: 200,
      json: screenAccess(new URL(request.headers().referer ?? request.url()).pathname),
    }));
    await mockRoute(page, "get", "/api/v1/access/granters", { status: 200, json: { count: 0, names: [] } });
    await mockRoute(page, "get", "/api/v1/support-sessions/active", { status: 200, json: { sessions: [], pending_count: 0, pending_approvals: [], can_approve: false } });
    // Keep the shell's event stream healthy, as mockScreen does, without feature fixtures.
    await page.addInitScript(() => {
      const fetch = window.fetch;
      window.fetch = (input, init) => {
        const request = input instanceof Request ? input : new Request(input, init);
        if (new URL(request.url).pathname !== "/api/v1/events") return fetch(input, init);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(": connected\n\n"));
          request.signal.addEventListener("abort", () => controller.close(), { once: true });
        } }), { headers: { "content-type": "text/event-stream" } }));
      };
    });
    const main = page.getByRole("main");
    let settled = false;
    try {
      await page.goto(route.replace(/\$[^/]+/g, id(3)));
      // All HTTP reads are immediate mocks; the shell stream above has no network request.
      await page.waitForLoadState("networkidle");
      // Fault reads retry on timers; a hidden layout placeholder is not an active read.
      settled = await expect(main.locator('[aria-busy="true"]:visible:not([aria-hidden="true"] *, [inert] *)'))
        .toHaveCount(0).then(() => true, () => false);
      if (state === "no-reference") await expect(main.locator("[data-support-reference]")).toHaveCount(0);
    } finally {
      const references = main.locator("[data-support-reference]");
      const count = await references.count();
      const observation = {
        route, state, support_ref: body.error.support_ref ?? null,
        reference_count: count, injected, settled,
        rendered_ref: count === 1 ? await references.getAttribute("data-support-reference") : null,
        display: count === 1 ? await references.locator("code").textContent({ timeout: 1000 }).catch(() => null) : null,
        copy_count: await references.getByRole("button", { name: "지원 참조 번호 복사", exact: true }).count(),
        raw_server_text: (await main.textContent({ timeout: 1000 }).catch(() => ""))?.includes(raw) ?? false,
        floorplan: await main.getAttribute("data-floorplan", { timeout: 1000 }).catch(() => null),
        declared_floorplan: inventory.floorplans?.[route] ?? null,
      };
      const shown = state === "no-reference" ? count === 0 : count === 1 && observation.rendered_ref === reference
        && observation.display === reference.slice(0, 8) && observation.copy_count === 1;
      await info.attach("support-reference", { contentType: "application/json", body: Buffer.from(JSON.stringify({
        ...observation, status: !settled || injected === 0 ? "unknown" : shown && !observation.raw_server_text ? "pass" : "fail",
      })) });
    }
  };
}
