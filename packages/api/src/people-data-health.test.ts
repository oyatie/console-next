// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { api, configure, peopleDataHealthApi, type Platform } from "./index";

const passkeys: Platform["passkeys"] = { get: async () => null, create: async () => null };
afterEach(() => vi.unstubAllGlobals());

test("peopleDataHealthApi routes data-health and draft-row identifier requests through typed endpoints", async () => {
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

  const client = peopleDataHealthApi(api);
  await client.getPeopleDataHealth({ category: "birth", limit: 10 });
  await client.recordImportRowIdentifier(
    "11111111-1111-1111-1111-111111111111",
    "row-2",
    { rrn: "900101-5000014", id_type: "DOMESTIC_RESIDENCE" },
  );

  expect(calls).toEqual([
    "GET https://console.example/api/v1/hr/people/data-health?category=birth&limit=10",
    "PUT https://console.example/api/v1/employees/import/11111111-1111-1111-1111-111111111111/rows/row-2/identifier",
  ]);
});
