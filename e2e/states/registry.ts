// SPDX-License-Identifier: LicenseRef-Proprietary
import { id } from "../mock/fixtures";
import { lifecycleSheetScreens } from "./lifecycle-sheets";
import type { accountScreens } from "./account";
import type { numberingScreens } from "./numbering";
// Executable state matrix, keyed to the central screen registry route records.
const states = {
  empty: "Return zero items and totals (first run / no work).",
  loading: "Hold the primary read until the test releases it; supporting reads succeed.",
  failed: "Return the contract ErrorBody with 503 on every primary-read attempt.",
  refused: "Return the common middleware ErrorBody with 403; granters and my access succeed.",
  populated: "Return three typed items (three departments for the chart).",
  long: "Return long Korean names and placement labels.",
  large: "Return 2,000 typed rows; honor roster and inbox cursor pagination.",
} as const;
export type State = keyof typeof states;
export const screens = [
  { key: "home", path: "/", read: "/api/v1/me/action-inbox", states, registry: "home--operating-업무함-one-live-action-inbox-default-tab", live: "e2e/inbox-live.spec.ts" },
  { key: "people", path: "/people", read: "/api/v1/employees", states, registry: "people--roster-populated-table-columns-sort-org_unit-name-employee_n", live: "e2e/people-reads.spec.ts" },
  { key: "org", path: "/org", read: "/api/v1/org-structure", states, registry: "org--chart-view-default", live: "e2e/structure-chart.spec.ts" },
] as const;
export const recordStatuses = {
  draft: "DRAFT", prechecked: "PRECHECKED", approval: "IN_APPROVAL", scheduled: "APPROVED",
  settling: "SETTLING", rejected: "REJECTED", cancelled: "CANCELLED", archived: "ARCHIVED",
} as const;
const recordStates = { loading: states.loading, failed: states.failed, refused: states.refused, populated: "Return an APPLIED record with its proposal and three history events.", long: "Return long Korean proposal, reason and actor labels." };
export const orgChangeScreens = [
  { key: "org-changes", path: "/org/changes?view=all", read: "/api/v1/org-changes", states: { ...states, large: "Return 2,000 summaries; honor status, drafter, effective range and offset/limit." }, registry: "org-changes--list-view-open-mine-approval-ready-done-closed-all", live: "e2e/orgchange-r2.spec.ts" },
  { key: "org-change", path: `/org/changes/${id(3000)}`, read: "/api/v1/org-changes/{id}", states: {
    ...recordStates, large: "Return one record with 2,000 history events.", missing: "Return the contract 404 not_found envelope.",
    ...Object.fromEntries(Object.entries(recordStatuses).map(([state, status]) => [state, `Return a ${status} record with its preflight, approval or settlement facts.`])),
  }, registry: "org-changes-id--approval-chain", live: "e2e/orgchange-r2.spec.ts" },
] as const;
export type Screen = (typeof screens)[number] | (typeof orgChangeScreens)[number] | (typeof lifecycleSheetScreens)[number] | (typeof accountScreens)[number] | (typeof numberingScreens)[number];
export type OrgChangeState = Exclude<State, "empty"> | keyof typeof recordStatuses | "missing";
