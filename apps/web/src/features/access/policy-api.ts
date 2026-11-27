// SPDX-License-Identifier: LicenseRef-Proprietary
import { api, assertPasskey, unwrap, type components, type operations } from "@console/api";
import { get, type PathPrefix } from "../../lib/query";

export type AccessReviewSummary = components["schemas"]["AccessReviewSummary"];
export type AccessReviewDetail = components["schemas"]["AccessReviewDetail"];
export type AccessReviewItem = components["schemas"]["AccessReviewItem"];
export type AccessReviewDecisionInput = components["schemas"]["AccessReviewDecisionInput"];

export type PolicyNoCodeCondition = {
  attr: string;
  op: "eq" | "ne" | "contains";
  value: { kind: "literal" | "subject_attr" | "bool"; value: string | boolean };
};

export type PolicyNoCodeBlocks = {
  effect: "permit" | "forbid";
  action: "view" | "edit" | "read_field" | "console:configure" | "console:deploy";
  resource_type: string;
  conditions: PolicyNoCodeCondition[];
};

export type PolicyCatalogEntry = {
  policy_id?: string;
  id?: string;
  title?: string;
  status?: string;
  effect?: string;
  updated_at?: string;
};

export type PolicyDraftRecord = {
  id: string;
  draft_key: string;
  title: string;
  author_note?: string | null;
  status: string;
  validation_status?: string;
  validation_errors?: string[];
  blocks?: PolicyNoCodeBlocks;
  created_by?: string;
  updated_at?: string;
};

export type PolicyDecisionEntry = {
  id?: string;
  subject_ref?: string;
  action?: string;
  resource_type?: string;
  resource_id?: string;
  effect?: string;
  determining_policies?: string[];
  reason?: string | null;
  decided_at?: string;
};

export type PolicySimulationOutcome = {
  effect: string;
  determining_policies?: string[];
  reason?: string | null;
};

export const POLICY_READS = ["/api/v1/policy"] as unknown as PathPrefix[];
export const ACCESS_REVIEW_READS = ["/api/v1/access/reviews", "/api/v1/access/grants"] as unknown as PathPrefix[];

export const accessReviewsQuery = {
  ...get("/api/v1/access/reviews"),
  refetchOnMount: "always" as const,
};

export const accessReviewDetailQuery = (period: string) => ({
  ...get("/api/v1/access/reviews/{period}", { params: { path: { period } } }),
  refetchOnMount: "always" as const,
});

export const startAccessReview = (period: string, key: string) =>
  unwrap(
    api.POST("/api/v1/access/reviews/{period}/start", {
      params: { path: { period }, header: { "Idempotency-Key": key } },
    }),
  );

export const recordAccessReviewDecision = (
  period: string,
  body: AccessReviewDecisionInput,
  key: string,
) =>
  unwrap(
    api.POST("/api/v1/access/reviews/{period}/decisions", {
      params: { path: { period }, header: { "Idempotency-Key": key } },
      body,
    }),
  );

export const completeAccessReview = async (period: string, key: string) =>
  unwrap(
    api.POST("/api/v1/access/reviews/{period}/complete", {
      params: { path: { period }, header: { "Idempotency-Key": key } },
      body: { step_up: await assertPasskey() },
    }),
  );

export const exportAccessReviewCsv = async (period: string): Promise<string> => {
  const res = await api.GET("/api/v1/access/reviews/{period}/export.csv", {
    params: { path: { period }, query: { export_purpose: "PERIODIC_ACCESS_REVIEW" } },
    parseAs: "text",
  });
  if (res.error || typeof res.data !== "string") {
    throw new Error("CSV export failed");
  }
  return res.data;
};

export const policyCatalogQuery = {
  ...get("/api/v1/policy/catalog"),
  queryFn: async () => (await unwrap(api.GET("/api/v1/policy/catalog"))) as PolicyCatalogEntry[],
};

export const policyDraftsQuery = {
  ...get("/api/v1/policy/drafts"),
  queryFn: async () => (await unwrap(api.GET("/api/v1/policy/drafts"))) as PolicyDraftRecord[],
  refetchOnMount: "always" as const,
};

export const policyDraftQuery = (draftId: string) => ({
  ...get("/api/v1/policy/drafts/{draft_id}", { params: { path: { draft_id: draftId } } }),
  queryFn: async () =>
    (await unwrap(
      api.GET("/api/v1/policy/drafts/{draft_id}", { params: { path: { draft_id: draftId } } }),
    )) as PolicyDraftRecord,
});

export const policyDecisionsQuery = {
  ...get("/api/v1/policy/decisions"),
  queryFn: async () => (await unwrap(api.GET("/api/v1/policy/decisions"))) as PolicyDecisionEntry[],
};

export const policyAuditEventsQuery = {
  ...get("/api/v1/policy/audit-events", { params: { query: { limit: 50 } } }),
  queryFn: async () =>
    (await unwrap(
      api.GET("/api/v1/policy/audit-events", { params: { query: { limit: 50 } } }),
    )) as Record<string, unknown>[],
};

export const createPolicyDraft = async (body: {
  draft_key: string;
  title: string;
  author_note?: string | null;
  blocks: PolicyNoCodeBlocks;
}) =>
  (await unwrap(
    api.POST("/api/v1/policy/drafts", {
      body: body as unknown as operations["createPolicyDraft"]["requestBody"]["content"]["application/json"],
    }),
  )) as PolicyDraftRecord;

export const updatePolicyDraft = async (
  draftId: string,
  body: { title?: string; author_note?: string | null; blocks: PolicyNoCodeBlocks },
) =>
  (await unwrap(
    api.PUT("/api/v1/policy/drafts/{draft_id}", {
      params: { path: { draft_id: draftId } },
      body: body as unknown as operations["updatePolicyDraft"]["requestBody"]["content"]["application/json"],
    }),
  )) as PolicyDraftRecord;

export const validatePolicyDraft = async (draftId: string) =>
  (await unwrap(
    api.POST("/api/v1/policy/drafts/{draft_id}/validate", {
      params: { path: { draft_id: draftId } },
    }),
  )) as PolicyDraftRecord;

export const submitPolicyDraft = async (draftId: string) =>
  (await unwrap(
    api.POST("/api/v1/policy/drafts/{draft_id}/submit", {
      params: { path: { draft_id: draftId } },
    }),
  )) as PolicyDraftRecord;

export const reviewPolicyDraft = async (
  draftId: string,
  body: { decision: "approve" | "reject"; note?: string | null },
) =>
  (await unwrap(
    api.POST("/api/v1/policy/drafts/{draft_id}/review", {
      params: { path: { draft_id: draftId } },
      body: body as unknown as operations["reviewPolicyDraft"]["requestBody"]["content"]["application/json"],
    }),
  )) as PolicyDraftRecord;

export const simulatePolicyDecision = async (body: {
  subject: { user_id: string; org: string; roles: string[]; clearance_keys?: string[] };
  action: string;
  resource: { resource_type: string; resource_id: string };
  include_draft_id?: string | null;
}) =>
  (await unwrap(
    api.POST("/api/v1/policy/simulate", {
      body: {
        request: {
          subject: {
            user_id: body.subject.user_id,
            org: body.subject.org,
            roles: body.subject.roles,
            clearance_keys: body.subject.clearance_keys ?? [],
          },
          action: body.action,
          resource: {
            org: body.subject.org,
            resource_type: body.resource.resource_type,
            resource_id: body.resource.resource_id,
          },
        },
        ...(body.include_draft_id ? { include_draft_id: body.include_draft_id } : {}),
      } as components["schemas"]["PolicySimulateRequest"],
    }),
  )) as { outcome: PolicySimulationOutcome };

export const authorizePolicyPoint = async (body: {
  user_id: string;
  org: string;
  roles: string[];
  action: string;
  resource_type: string;
  resource_id: string;
}) =>
  (await unwrap(
    api.POST("/api/v1/policy/authorize", {
      body: {
        request: {
          subject: {
            user_id: body.user_id,
            org: body.org,
            roles: body.roles,
            clearance_keys: [],
          },
          action: body.action,
          resource: {
            org: body.org,
            resource_type: body.resource_type,
            resource_id: body.resource_id,
          },
        },
      } as components["schemas"]["PolicyAuthorizeRequest"],
    }),
  )) as { outcome: PolicySimulationOutcome };

export const authorizePolicyBulk = async (body: {
  user_id: string;
  org: string;
  roles: string[];
  resource_type: string;
  resource_id: string;
  actions: string[];
}) =>
  (await unwrap(
    api.POST("/api/v1/policy/authorize/bulk", {
      body: {
        subject: {
          user_id: body.user_id,
          org: body.org,
          roles: body.roles,
          clearance_keys: [],
        },
        checks: body.actions.map((action) => ({
          action,
          resource: {
            org: body.org,
            resource_type: body.resource_type,
            resource_id: body.resource_id,
          },
        })),
      } as operations["authorizeBulk"]["requestBody"]["content"]["application/json"],
    }),
  )) as { decisions: PolicySimulationOutcome[] };
