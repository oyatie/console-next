// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, unwrap } from "@console/api";
import type { components } from "@console/api/schema";
import { get } from "../../../lib/query";

export type SubmittableDefinition = components["schemas"]["SubmittableDefinitionResponse"];
export type ApprovalLineOverrideStep = components["schemas"]["ApprovalLineOverrideStep"];
export type StartWorkflowRunRequest = components["schemas"]["StartWorkflowRunRequest"];
export type StartWorkflowRunResponse = components["schemas"]["StartWorkflowRunResponse"];

export const submittableDefinitionsQuery = get("/api/v1/workflow-studio/submittable-definitions");

export function startWorkflowRun(body: StartWorkflowRunRequest) {
  return unwrap(api.POST("/api/v1/workflow-runs", { body }));
}
