// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import { afterEach, expect, test, vi } from "vitest";
import { platformOperatorsApi, type paths } from "./index";

afterEach(() => vi.unstubAllGlobals());

test("platformOperatorsApi calls all four /api/platform/operators endpoints", async () => {
  const seen: Array<{ method: string; url: string; body: unknown }> = [];
  const client = createClient<paths>({
    baseUrl: "https://console.example",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      const rawBody = request.method === "GET" ? null : await request.text();
      seen.push({
        method: request.method,
        url: request.url,
        body: rawBody ? JSON.parse(rawBody) : null,
      });
      const payload =
        request.method === "GET"
          ? []
          : request.url.endsWith("/revoke")
            ? {
                user_id: "00000000-0000-0000-0000-000000000002",
                display_name: "Second Op",
                sign_in_id: "op2@platform",
                is_active: false,
                has_passkey: false,
                device_bound_passkey: false,
                status: "REVOKED",
                invited_by: "00000000-0000-0000-0000-000000000001",
                invite_expires_at: null,
                created_at: "2026-11-20T06:00:00Z",
              }
            : {
                operator: {
                  user_id: "00000000-0000-0000-0000-000000000002",
                  display_name: "Second Op",
                  sign_in_id: "op2@platform",
                  is_active: true,
                  has_passkey: false,
                  device_bound_passkey: false,
                  status: "PENDING_ENROLMENT",
                  invited_by: "00000000-0000-0000-0000-000000000001",
                  invite_expires_at: "2026-11-21T06:00:00Z",
                  created_at: "2026-11-20T06:00:00Z",
                },
                invite_token: "cop_test",
                expires_at: "2026-11-21T06:00:00Z",
              };
      return new Response(JSON.stringify(payload), {
        status: request.method === "POST" && request.url.endsWith("/operators") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const api = platformOperatorsApi(client);
  await expect(api.list()).resolves.toEqual([]);
  const invited = await api.invite({
    id: "00000000-0000-0000-0000-000000000002",
    display_name: "Second Op",
    login: "op2",
  });
  expect(invited.invite_token).toBe("cop_test");
  await api.reissue("00000000-0000-0000-0000-000000000002", {});
  const revoked = await api.revoke("00000000-0000-0000-0000-000000000002", {
    reason: "departure",
  });
  expect(revoked.status).toBe("REVOKED");

  expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
    "GET https://console.example/api/platform/operators",
    "POST https://console.example/api/platform/operators",
    "POST https://console.example/api/platform/operators/00000000-0000-0000-0000-000000000002/reissue",
    "POST https://console.example/api/platform/operators/00000000-0000-0000-0000-000000000002/revoke",
  ]);
});
