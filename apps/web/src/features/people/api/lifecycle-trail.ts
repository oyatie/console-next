// SPDX-License-Identifier: LicenseRef-Proprietary
export { sha256Hex as trailPayloadHash } from "@console/api";
import { api, ApiError, assertBoundPasskey, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { canonical } from "../domain/canonical";
import { get } from "../../../lib/query";
export { lifecycleCasesQuery, lifecycleCaseQuery, LIFECYCLE_CASE_READS } from "../../../reference/lifecycle/api";
export type LifecycleCase = components["schemas"]["LifecycleCase"];
export type CaseItem = components["schemas"]["LifecycleCaseItem"];
export type CompleteItem = components["schemas"]["CompleteLifecycleItem"];
export async function completeCaseItem(id: string, item_id: string, body: CompleteItem) {
  const send = (next: CompleteItem) => unwrap(api.POST("/api/v1/lifecycle-cases/{id}/items/{item_id}/complete", { params: { path: { id, item_id } }, body: next }));
  try { return await send(body); }
  catch (error) {
    if (!(error instanceof ApiError && error.status === 401 && error.code === "step_up_required") || !body.attestation) throw error;
    const step_up = await assertBoundPasskey("EXCEPTION_DECIDE", item_id, canonical({ case_id: id, item_id, expected_version: body.expected_version, attestation: body.attestation }));
    return send({ ...body, step_up });
  }
}
export const closeLifecycleCase = (id: string) => unwrap(api.POST("/api/v1/lifecycle-cases/{id}/close", { params: { path: { id } } }));

export type TemplatePreviewQuery = NonNullable<import("@console/api/schema").paths["/api/v1/lifecycle-case-templates/{key}"]["get"]["parameters"]["query"]>;
export const lifecycleTemplateQuery = (key: string, query?: TemplatePreviewQuery) => get("/api/v1/lifecycle-case-templates/{key}", { params: { path: { key }, query } });
