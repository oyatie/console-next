// SPDX-License-Identifier: LicenseRef-Proprietary
import type { Requirement } from "../reference/authz/domain/access";
import { routeAccess } from "./route-operation-access";
export { overtimeReadAccess } from "./route-operation-access";
export { alternativeRouteReads, routeReads } from "./route-read-data";

/** Served routes require their own server permission decision before the register reads. */
export const proposeEvidenceAccess = { servedCapability: "served_compliance_evidence_link" } as const;
export const evidenceBindingsAccess = { servedCapability: "served_compliance_evidence" } as const;
export const complianceCatalogAccess = { servedCapability: "served_compliance_catalog" } as const;
export const manageComplianceAccess = { servedCapability: "served_compliance_catalog_manage" } as const;
export const payrollOutlookAccess = { servedCapability: "analytics_projection" } as const;
export const recordLifecycleAccess = { servedCapability: "lifecycle_manage" } as const;
export const consultingEntryAccess = { servedCapability: "served_consulting_entry" } as const;
export const consultingEngagementAccess = { servedCapability: "served_consulting" } as const;
export const evaluationCyclesAccess = { servedCapability: "served_evaluation_cycles" } as const;
export const createEvaluationAccess = { servedCapability: "served_evaluation_cycle_create" } as const;
export const evaluationTasksAccess = { servedCapability: "served_evaluation_tasks" } as const;
export const restrictedAuditAccess = { servedCapability: "restricted_audit_stream" } as const;
export const calendarAccess = { servedCapability: "served_calendar" } as const;
export const benefitsAccess = { servedCapability: "served_benefit_catalog" } as const;
export const locationLedgerAccess = { servedCapability: "served_location_consent_ledger" } as const;
export const integrityFindingsAccess = { servedCapability: "served_integrity_findings" } as const;
export const evidenceVaultAccess = { servedCapability: "documents" } as const;

/** Request inventory for route verification; the browser only needs the admission map. */
export const servedRouteReads = {
  "/compliance/evidence/new": { access: proposeEvidenceAccess, reads: ["/api/v1/me/authz"] },
  "/compliance/evidence": { access: evidenceBindingsAccess, reads: ["/api/v1/compliance/evidence-bindings"] },
  "/compliance": { access: complianceCatalogAccess, reads: ["/api/v1/compliance/frameworks", "/api/v1/compliance/obligations"] },
  "/compliance/new": { access: manageComplianceAccess, reads: ["/api/v1/me/authz"] },
  "/payroll/outlook": { access: payrollOutlookAccess, reads: ["/api/v1/analytics/projection"], method: "post" },
  "/audit/lifecycles/$objectType/$objectId": { access: recordLifecycleAccess, reads: ["/api/v1/lifecycles/{objectType}/{objectId}"] },
  "/consulting": { access: consultingEntryAccess, reads: ["/api/v1/consulting/engagements"] },
  "/consulting/engagements/$engagementId": { access: consultingEngagementAccess, reads: ["/api/v1/consulting/engagements/{engagement_id}", "/api/v1/consulting/engagements/{engagement_id}/history"] },
  "/evaluation": { access: evaluationCyclesAccess, reads: ["/api/v1/evaluation/cycles"] },
  "/evaluation/new": { access: createEvaluationAccess, reads: ["/api/v1/me/authz"] },
  "/me/evaluations": { access: evaluationTasksAccess, reads: ["/api/v1/evaluation/my-tasks"] },
  "/audit/restricted": { access: restrictedAuditAccess, reads: ["/api/v1/audit-streams/ceo-covert/events", "/api/v1/audit-streams/ceo-covert/access-events"] },
  "/calendar": { access: calendarAccess, reads: ["/api/v1/collaboration/calendar/events"] },
  "/benefits": { access: benefitsAccess, reads: ["/api/v1/benefit-catalog/items"] },
  "/audit/location-consents": { access: locationLedgerAccess, reads: ["/api/v1/location-consents/ledger"] },
  "/audit/findings": { access: integrityFindingsAccess, reads: ["/api/v1/integrity/findings"] },
  "/audit/evidence": { access: evidenceVaultAccess, reads: ["/api/v1/evidence/objects"] },
} as const;

export function readRequirement(path: keyof typeof routeAccess): Requirement | { allOf: readonly Requirement[] } {
  return routeAccess[path];
}
