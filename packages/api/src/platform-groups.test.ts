// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import { afterEach, expect, test, vi } from "vitest";
import { platformGroupsApi, type paths } from "./index";

afterEach(() => vi.unstubAllGlobals());

test("platformGroupsApi calls all /api/platform/groups endpoints", async () => {
  const seen: Array<{ method: string; url: string }> = [];
  const groupId = "00000000-0000-0000-0000-000000000010";
  const orgId = "00000000-0000-0000-0000-000000000020";
  const userId = "00000000-0000-0000-0000-000000000030";
  const group = {
    id: groupId,
    slug: "hq",
    name: "HQ Group",
    status: "ACTIVE",
    member_count: 1,
    members: [],
    created_at: "2026-11-21T00:00:00Z",
    updated_at: "2026-11-21T00:00:00Z",
  };
  const account = {
    person_id: "00000000-0000-0000-0000-000000000040",
    principal_kind: "TENANT_PERSON",
    user_id: userId,
    display_name: "Group Admin",
    phone: null,
    tenant_roles: ["MEMBER"],
    is_active: true,
    has_passkey: false,
    account_status: "PENDING_SETUP",
    org_id: orgId,
    org_slug: "alpha",
    org_name: "Alpha",
    group_roles: ["GROUP_ADMIN"],
    created_at: "2026-11-21T00:00:00Z",
  };

  const client = createClient<paths>({
    baseUrl: "https://console.example",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push({ method: request.method, url: request.url });
      if (request.method === "DELETE" && request.url.includes("/roles/")) {
        return new Response(null, { status: 204 });
      }
      const payload = request.url.endsWith("/groups") && request.method === "GET"
        ? [group]
        : request.url.endsWith("/accounts") && request.method === "GET"
          ? [account]
          : request.url.endsWith("/accounts") && request.method === "POST"
            ? { account, otp: "12345678", otp_expires_at: "2026-11-22T00:00:00Z" }
            : request.url.includes("/organizations/")
              ? {
                  id: orgId,
                  slug: "alpha",
                  name: "Alpha",
                  status: "ACTIVE",
                  group_id: groupId,
                  group_name: "HQ Group",
                  created_at: "2026-11-21T00:00:00Z",
                }
              : group;
      return new Response(JSON.stringify(payload), {
        status: request.method === "POST" && !request.url.endsWith("/roles/") ? 201 : 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const api = platformGroupsApi(client);
  await expect(api.list()).resolves.toHaveLength(1);
  await expect(api.create({ slug: "hq", name: "HQ Group" })).resolves.toMatchObject({ id: groupId });
  await expect(api.update(groupId, { name: "HQ Updated" })).resolves.toMatchObject({ id: groupId });
  const accounts = await api.listAccounts(groupId);
  expect(accounts[0]?.principal_kind).toBe("TENANT_PERSON");
  expect(accounts[0]?.person_id).toBe("00000000-0000-0000-0000-000000000040");
  await expect(
    api.createAccount(groupId, {
      org_id: orgId,
      display_name: "Group Admin",
      tenant_roles: ["MEMBER"],
      group_role: "GROUP_ADMIN",
      step_up: { ceremony_id: "00000000-0000-0000-0000-000000000050", credential: {} as never },
    }),
  ).resolves.toMatchObject({ otp: "12345678" });
  await expect(api.revokeRole(groupId, userId, "GROUP_ADMIN")).resolves.toBeUndefined();
  await expect(
    api.assignOrg(groupId, orgId, {
      step_up: { ceremony_id: "00000000-0000-0000-0000-000000000051", credential: {} as never },
    }),
  ).resolves.toMatchObject({ id: orgId });
  await expect(api.removeOrg(groupId, orgId)).resolves.toMatchObject({ id: orgId });

  expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
    "GET https://console.example/api/platform/groups",
    "POST https://console.example/api/platform/groups",
    `PATCH https://console.example/api/platform/groups/${groupId}`,
    `GET https://console.example/api/platform/groups/${groupId}/accounts`,
    `POST https://console.example/api/platform/groups/${groupId}/accounts`,
    `DELETE https://console.example/api/platform/groups/${groupId}/accounts/${userId}/roles/GROUP_ADMIN`,
    `PUT https://console.example/api/platform/groups/${groupId}/organizations/${orgId}`,
    `DELETE https://console.example/api/platform/groups/${groupId}/organizations/${orgId}`,
  ]);
});
