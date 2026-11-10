// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components, paths } from "../schema";

type S = components["schemas"];
/** Offered only after Cedar evaluates the viewer, current step, holder count and sole-holder policy. */
export type SoleHolderDecision = {
  step_id: string;
  expected_version: string;
  payload_hash: string;
  notice_count: number;
  review_due_at: string;
};
export type SoleHolderException = { id: string; notice_count: number; review_due_at: string };
/** Pending extension; an absent offer preserves the ordinary second-person route on older backends. */
export type OrgChangeDetail = S["OrgChangeDetail"] & {
  sole_holder_decision?: SoleHolderDecision | null;
  sole_holder_exception?: SoleHolderException | null;
};
type Read = paths["/api/v1/org-changes/{id}"];
type Decide = paths["/api/v1/org-changes/{id}/approval-steps/{stepId}/decision"];
type Json<T> = { content: { "application/json": T } };
type WithDetail<T extends { responses: { 200: unknown } }> = Omit<T, "responses"> & {
  responses: Omit<T["responses"], 200> & { 200: T["responses"][200] & Json<OrgChangeDetail> };
};
export type OrgChangePaths = {
  "/api/v1/org-changes/{id}": Omit<Read, "get"> & { get: WithDetail<Read["get"]> };
  "/api/v1/org-changes/{id}/approval-steps/{stepId}/decision": Omit<Decide, "post"> & {
    post: Omit<WithDetail<Decide["post"]>, "requestBody"> & {
      requestBody: Json<S["OrgChangeDecisionRequest"] & { step_up?: S["MobilePasskeyStepUpEnvelope"] }>;
    };
  };
};
