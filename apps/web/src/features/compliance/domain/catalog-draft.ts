// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";
import { controlTypes, coverage, frameworkKinds, obligationTypes, relationships, risk } from "../present";

type Schema = components["schemas"];
export const actions = ["framework", "regulation", "obligation", "control", "regulationLink", "coverage"] as const;
export type CatalogAction = typeof actions[number];

export type CatalogCommand =
  | { action: "framework"; body: Schema["CreateComplianceFrameworkRequest"] }
  | { action: "regulation"; body: Schema["CreateRegulationImpactRequest"] }
  | { action: "obligation"; body: Schema["CreateComplianceObligationRequest"] }
  | { action: "control"; body: Schema["CreateComplianceControlRequest"] }
  | { action: "regulationLink"; body: Schema["LinkObligationRegulationRequest"] }
  | { action: "coverage"; body: Schema["LinkControlObligationRequest"] };

export const initial = {
  name: "", version: "", jurisdiction: "", citation: "", area: "", detail: "", controlKey: "",
  framework: "", control: "", obligation: "", regulation: "", site: "", from: "", to: "",
  frameworkKind: frameworkKinds[0] as typeof frameworkKinds[number], controlType: controlTypes[0] as typeof controlTypes[number],
  obligationType: obligationTypes[0] as typeof obligationTypes[number], risk: "MEDIUM" as typeof risk[number],
  relationship: relationships[0] as typeof relationships[number], coverage: coverage[0] as typeof coverage[number],
};
export type Draft = typeof initial;
const isId = (s: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(s);

export function catalogCommand(action: CatalogAction, d: Draft, org: boolean, branch: string): CatalogCommand | undefined {
  const title = d.name.trim();
  const detail = d.detail.trim();
  const dates = { effective_from: d.from || null, effective_to: d.to || null };
  if (d.from && d.to && d.from > d.to) return;
  switch (action) {
    case "framework": return org && title && d.version.trim() ? { action, body: { name: title, version_label: d.version.trim(), framework_kind: d.frameworkKind, ...dates } } : undefined;
    case "regulation": return org && title && d.jurisdiction.trim() && d.citation.trim() && d.area.trim() && detail ? { action, body: { title, jurisdiction: d.jurisdiction.trim(), citation: d.citation.trim(), impact_area: d.area.trim(), impact_summary: detail, risk_level: d.risk, ...dates } } : undefined;
    case "obligation": return title && detail && (org || isId(branch)) && (!d.site || isId(branch) && isId(d.site)) ? { action, body: { title, description: detail, obligation_type: d.obligationType, severity: d.risk, scope: d.site ? { kind: "SITE", scope_ref: d.site, site_id: d.site, branch_id: branch } : branch ? { kind: "BRANCH", scope_ref: branch, branch_id: branch } : { kind: "ORG" }, ...dates } } : undefined;
    case "control": return org && title && detail && d.controlKey.trim() && isId(d.framework) ? { action, body: { framework_id: d.framework, control_key: d.controlKey.trim(), title, objective: detail, control_type: d.controlType } } : undefined;
    case "regulationLink": return org && isId(d.regulation) && isId(d.obligation) ? { action, body: { obligation_id: d.obligation, regulation_impact_id: d.regulation, relationship: d.relationship, rationale: detail || null } } : undefined;
    case "coverage": return org && isId(d.control) && isId(d.obligation) ? { action, body: { control_id: d.control, obligation_id: d.obligation, coverage_level: d.coverage, coverage_rationale: detail || null } } : undefined;
  }
}
