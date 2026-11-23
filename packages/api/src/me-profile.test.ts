// SPDX-License-Identifier: LicenseRef-Proprietary
import createClient from "openapi-fetch";
import { expect, test } from "vitest";
import { meProfileApi, type paths } from "./index";

test("meProfileApi targets all self-service profile and certificate endpoints", async () => {
  const seen: string[] = [];
  const client = createClient<paths>({
    baseUrl: "https://console.example",
    fetch: async (input) => {
      const request = input instanceof Request ? input : new Request(input);
      seen.push(`${request.method} ${request.url}`);
      return new Response(JSON.stringify({}), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const apiClient = meProfileApi(client);
  await apiClient.getProfile();
  await apiClient.updateProfile({ phone: "010-1234-5678" });
  await apiClient.revealField({
    field: "PHONE",
    step_up: null,
  });
  await apiClient.createChangeRequest({
    field: "bank_account_registered",
    bank_account_registered: true,
  });
  await apiClient.listCertificates({ limit: 10, cursor: "c1" });
  await apiClient.issueCertificate(
    { kind: "EMPLOYMENT", items: ["period", "position"], purpose: "bank" },
    "00000000-0000-0000-0000-000000000001",
  );
  await apiClient.getCertificate("00000000-0000-0000-0000-000000000002");

  expect(seen).toEqual([
    "GET https://console.example/api/v1/me/profile",
    "PATCH https://console.example/api/v1/me/profile",
    "POST https://console.example/api/v1/me/profile/reveal",
    "POST https://console.example/api/v1/me/profile/change-requests",
    "GET https://console.example/api/v1/me/certificates?limit=10&cursor=c1",
    "POST https://console.example/api/v1/me/certificates",
    "GET https://console.example/api/v1/me/certificates/00000000-0000-0000-0000-000000000002",
  ]);
});
