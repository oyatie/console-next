// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, ApiError, assertBoundPasskeyHash, unwrap } from "@console/api";
import type { SoleHolderDecision } from "@console/api/pending";

/** The server rechecks the version, holder facts and policy before recording the exception and notices atomically. */
export async function decideSoleHolder(id: string, offer: SoleHolderDecision, key: string) {
  const step_up = await assertBoundPasskeyHash("EXCEPTION_DECIDE", id, offer.payload_hash);
  const result = await unwrap(api.POST("/api/v1/org-changes/{id}/approval-steps/{stepId}/decision", {
    headers: { "Idempotency-Key": key },
    params: { path: { id, stepId: offer.step_id } },
    body: { decision: "APPROVED", expected_version: offer.expected_version, step_up },
  }));
  if (!result.sole_holder_exception) throw new ApiError(0, "command_unknown", "");
  return result;
}
