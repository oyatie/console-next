// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, assertPasskey, unwrap, type components } from "@console/api";
import type { PathPrefix } from "../../../lib/query";

export type PreviewAccessInviteRequest = components["schemas"]["PreviewAccessInviteRequest"];
export type PreviewAccessInviteResponse = components["schemas"]["PreviewAccessInviteResponse"];
export type CreateAccessInviteBody = Omit<components["schemas"]["CreateAccessInviteRequest"], "step_up">;
export type CreateAccessInviteResponse = components["schemas"]["CreateAccessInviteResponse"];

export const INVITE_WITH_ROLES_INVALIDATES = [
  "/api/v1/directory",
  "/api/v1/users",
  "/api/v1/access",
  "/api/v1/onboarding",
] as unknown as PathPrefix[];

export const previewAccessInvite = (body: PreviewAccessInviteRequest) =>
  unwrap(api.POST("/api/v1/access/invites/preview", { body }));

export const createAccessInvite = async (body: CreateAccessInviteBody, key: string) =>
  unwrap(
    api.POST("/api/v1/access/invites", {
      params: { header: { "Idempotency-Key": key } },
      body: { ...body, step_up: await assertPasskey() },
    }),
  );
