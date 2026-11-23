// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { api, configure, hrWaterfallApi, type Platform } from "./index";

const passkeys: Platform["passkeys"] = { get: async () => null, create: async () => null };
afterEach(() => vi.unstubAllGlobals());

test("hrWaterfallApi routes batch, position, and count requests through typed endpoints", async () => {
  configure({ baseUrl: "https://console.example", passkeys, refresh: { kind: "cookie" } });
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: Request | string, init?: RequestInit) => {
    const request = new Request(input, init);
    calls.push(`${request.method} ${request.url}`);
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const client = hrWaterfallApi(api);
  await client.queryRegisterFacts({ ids: ["11111111-1111-1111-1111-111111111111"] });
  await client.getEmployeeUnitPosition("11111111-1111-1111-1111-111111111111");
  await client.bulkReportExitCases(
    {
      effective_exit_date: "2026-10-31",
      site_manager_note: "batch",
      items: [{ employee_id: "11111111-1111-1111-1111-111111111111" }],
    },
    "bulk-key-1234567890",
  );
  await client.getExitCaseCounts({ search: "kim" });
  await client.getChangeRequestCounts();

  expect(calls).toEqual([
    "POST https://console.example/api/v1/employees/register-facts/query",
    "GET https://console.example/api/v1/employees/11111111-1111-1111-1111-111111111111/unit-position",
    "POST https://console.example/api/v1/hr/exit-cases/bulk",
    "GET https://console.example/api/v1/hr/exit-cases/counts?search=kim",
    "GET https://console.example/api/v1/change-requests/counts",
  ]);
});
