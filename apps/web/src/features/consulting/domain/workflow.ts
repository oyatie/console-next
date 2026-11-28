// SPDX-License-Identifier: LicenseRef-Proprietary
import type { components } from "@console/api/schema";

type Schema = components["schemas"];
export type Engagement = Schema["ConsultingEngagementDetail"];
export type Change =
  | { kind: "diagnostic"; body: Schema["ConsultingDiagnosticCreateRequest"] }
  | { kind: "finding"; body: Schema["ConsultingFindingCreateRequest"] }
  | { kind: "initiative"; body: Schema["ConsultingInitiativeCreateRequest"] }
  | { kind: "observation"; body: Schema["ConsultingObservationCreateRequest"] }
  | { kind: "transition"; body: Schema["ConsultingTransitionRequest"] };
export type Next = Extract<Change, { kind: "transition" }>["body"]["toStatus"];
export function stages(row: Engagement): Next[] {
  switch (row.status) {
    case "DRAFT": return ["PROPOSED"];
    case "PROPOSED": return ["APPROVED"];
    case "APPROVED": return row.initiatives.length ? ["IMPLEMENTED"] : [];
    case "IMPLEMENTED": return ["MEASURED"];
    case "MEASURED": return row.observations.length ? ["SUSTAINED", "CORRECTIVE"] : [];
    default: return [];
  }
}
export function availableChanges(row: Engagement): Change["kind"][] {
  if (row.status === "SUSTAINED" || row.status === "CORRECTIVE") return [];
  const kinds: Change["kind"][] = ["diagnostic"];
  if (row.diagnostics.length) kinds.push("finding");
  if (row.findings.length) kinds.push("initiative");
  if (row.initiatives.length && (row.status === "IMPLEMENTED" || row.status === "MEASURED")) kinds.push("observation");
  if (stages(row).length) kinds.push("transition");
  return kinds;
}
