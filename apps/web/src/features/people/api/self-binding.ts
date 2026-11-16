// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, assertBoundPasskeyHash, assertPasskey, unwrap } from "@console/api";
import { get, read } from "../../../lib/query";
import type { components } from "@console/api/schema";

const prepareSelfBinding = (employeeId: string, confirmedName?: string) =>
  unwrap(api.POST("/api/v1/users/me/employee-link/prepare", { body: { employee_id: employeeId, confirmed_name: confirmedName } }));
export const selfBindingOffer = (employeeId: string) =>
  read("/api/v1/users/me/employee-link/prepare", async () => {
    try { await prepareSelfBinding(employeeId); }
    catch (error) {
      if (!(error instanceof ApiError) || error.code !== "account_link.refuse.not_own_record") throw error;
    }
    return true;
  }, employeeId);

export const selfBindingReceipt = () => get("/api/v1/users/me/employee-link");

export async function bindOwnAccount(employeeId: string, confirmedName: string) {
  const binding = await prepareSelfBinding(employeeId, confirmedName);
  const step_up = await assertBoundPasskeyHash("EXCEPTION_DECIDE", binding.object_id, binding.payload_hash ?? "");
  return unwrap(api.POST("/api/v1/users/me/employee-link", { body: { employee_id: employeeId, confirmed_name: confirmedName, step_up } }));
}

export async function withdrawOwnBinding(attestationId: string) {
  return unwrap(api.POST("/api/v1/users/me/employee-link/withdraw", {
    body: { attestation_id: attestationId, step_up: await assertPasskey() },
  }));
}

export async function reviewSelfAttestedBinding(id: string, decision: components["schemas"]["SelfBindingReviewRequest"]["decision"]) {
  return unwrap(api.POST("/api/v1/users/employee-link-attestations/{id}/review", {
    params: { path: { id } }, body: { decision, step_up: await assertPasskey() },
  }));
}
