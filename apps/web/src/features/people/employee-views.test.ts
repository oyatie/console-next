// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test, vi } from "vitest";
import { ApiError, configure } from "@console/api";
import { employeeViewsQuery } from "./api/roster";

afterEach(() => vi.unstubAllGlobals());

test.each([403, 404, 405, 503, 200])("saved views distinguish an unavailable personal feature from status %s", async status => {
  configure({ baseUrl: "https://console.example", refresh: { kind: "cookie" }, passkeys: { get: async () => null, create: async () => null } });
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify(status === 200 ? { items: [] } : { error: { code: "unavailable", message: "" } }), {
    status, headers: { "content-type": "application/json" },
  }));
  const read = employeeViewsQuery.queryFn();
  if (status === 403 || status === 404 || status === 405) await expect(read).resolves.toBeNull();
  else if (status === 200) await expect(read).resolves.toEqual({ items: [] });
  else await expect(read).rejects.toBeInstanceOf(ApiError);
});
