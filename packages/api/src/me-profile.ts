// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Client } from "openapi-fetch";
import type { components, paths } from "./schema";
import { unwrap } from "./client";

type MeProfilePaths = Pick<
  paths,
  | "/api/v1/me/profile"
  | "/api/v1/me/profile/reveal"
  | "/api/v1/me/profile/change-requests"
  | "/api/v1/me/certificates"
  | "/api/v1/me/certificates/{id}"
>;

export const meProfileApi = (client: Client<MeProfilePaths>) => ({
  getProfile: () => unwrap(client.GET("/api/v1/me/profile")),
  updateProfile: (body: components["schemas"]["UpdateMeProfileRequest"]) =>
    unwrap(client.PATCH("/api/v1/me/profile", { body })),
  revealField: (body: components["schemas"]["SelfRevealRequest"]) =>
    unwrap(client.POST("/api/v1/me/profile/reveal", { body })),
  createChangeRequest: (body: components["schemas"]["CreateSelfChangeRequest"]) =>
    unwrap(client.POST("/api/v1/me/profile/change-requests", { body })),
  listCertificates: (query?: { cursor?: string; limit?: number }) =>
    unwrap(client.GET("/api/v1/me/certificates", { params: { query } })),
  issueCertificate: (
    body: components["schemas"]["SelfIssueCertificateRequest"],
    idempotencyKey: string,
  ) =>
    unwrap(
      client.POST("/api/v1/me/certificates", {
        body,
        params: { header: { "Idempotency-Key": idempotencyKey } },
      }),
    ),
  getCertificate: (id: string) =>
    unwrap(client.GET("/api/v1/me/certificates/{id}", { params: { path: { id } } })),
});
