// SPDX-License-Identifier: LicenseRef-Proprietary
import { afterEach, expect, test } from "vitest";
import { i18n, loadCatalog, t } from "@console/i18n";
import { approvalRouteSteps, decisionRefusalText, proposalDiffs, relatedApprovalLinks } from "./present";
import type { ApprovalDocument } from "./api";

afterEach(() => i18n.set("ko"));

test.each(["ko", "en"] as const)("read and command refusals share the unavailable message in %s", async locale => {
  await loadCatalog(locale);
  i18n.set(locale);
  expect(decisionRefusalText("approval_decision_unavailable")).toBe(t("approvals.viewer.unavailable"));
  expect(decisionRefusalText("future_refusal")).toBe(t("approvals.viewer.blockedHint"));
});

test("proposalDiffs formats org unit rename, move, reassign, dissolve, create without duplicating subject and before", async () => {
  await loadCatalog("ko");
  i18n.set("ko");
  const diffs = proposalDiffs({
    title: "Org restructure",
    proposal_names: { u1: "Team A", u2: "Team B", p1: "Division 1" },
    proposal: [
      { op: "RENAME_ORG_UNIT", orgUnitId: "u1", name: "Team A2" },
      { op: "MOVE_ORG_UNIT", orgUnitId: "u1", parentId: "p1" },
      { op: "REASSIGN_ORG_UNIT", fromOrgUnit: "u1", toOrgUnit: "u2", scope: { company: "c1" } },
      { op: "DISSOLVE_ORG_UNIT", orgUnitId: "u1", mergedInto: "u2" },
      { op: "CREATE_ORG_UNIT", kind: "TEAM", name: "Team C", parentId: "p1" },
    ],
  });
  expect(diffs).toEqual([
    { id: "op-0", subject: t("orgPropose.diff.chip.renamed"), before: "Team A", after: "Team A2" },
    { id: "op-1", subject: "Team A", before: t("orgPropose.diff.now"), after: "Division 1" },
    { id: "op-2", subject: t("home.worklist.impact.transfer"), before: "Team A", after: "Team B" },
    { id: "op-3", subject: "Team A", before: t("enum.unitStatus.ACTIVE"), after: t("orgPropose.diff.chip.dissolved") },
    { id: "op-4", subject: "Team C", before: "—", after: "Division 1" },
  ]);
  for (const row of diffs) {
    expect(row.subject).not.toBe(row.before);
  }
});

test("approvalRouteSteps provides fallback step status meta and hides current-step turn meta when decision_refusal is set", async () => {
  await loadCatalog("ko");
  i18n.set("ko");
  const base: ApprovalDocument = {
    id: "d1",
    box: "pending",
    title: "Doc",
    summary: "Summary",
    source: { key: "org_change", label: "Org" },
    status: { key: "IN_APPROVAL", label: "In approval", tone: "warn" },
    requested_at: "2026-11-06T09:00:00Z",
    facts: [],
    route: [
      { id: "s1", label: "Draft", assignee: "Kim", state: "done", meta: "11-06" },
      { id: "s2", label: "Approve", assignee: "Moon", state: "current", meta: "Your turn" },
    ],
    body: [],
    revision: 1,
    fingerprint: "fp-1",
    consequence: "final",
    opinion_max: 500,
    my_actions: { kind: "none" },
  };
  expect(approvalRouteSteps(base)[1]?.meta).toBe("Your turn");
  expect(approvalRouteSteps({ ...base, decision_refusal: "org_change_sod_violation" })[1]?.meta).toBeUndefined();
  const inferred = approvalRouteSteps({
    ...base,
    route: [
      { id: "s1", label: "Draft", assignee: "Kim", state: "done" },
      { id: "s2", label: "Approve", assignee: "Moon", state: "current" },
      { id: "s3", label: "Final", assignee: "Han", state: "waiting" },
    ],
  });
  expect(inferred.map(step => step.meta)).toEqual([
    `${t("home.inbox.tab.done")} 11-06`,
    t("orgChange.chain.current"),
    t("orgChange.settle.waiting"),
  ]);
});

test("relatedApprovalLinks derives genuine roster, org, and viewer links", async () => {
  await loadCatalog("ko");
  i18n.set("ko");
  const links = relatedApprovalLinks({
    source: { key: "org_change", label: "Org change" },
    viewer: { kind: "org_change", id: "oc-1" },
    proposal: [
      { op: "REASSIGN_ORG_UNIT", fromOrgUnit: "u3", toOrgUnit: "u2", scope: { company: "c1" } },
      { op: "DISSOLVE_ORG_UNIT", orgUnitId: "u3", mergedInto: "u2" },
    ],
    proposal_names: { u2: "Team 2", u3: "Team 3" },
  });
  expect(links.map(link => ({ kind: link.kind, label: link.label, to: link.to }))).toEqual([
    { kind: t("approvals.related.roster"), label: "Team 3", to: "/people" },
    { kind: t("approvals.related.org"), label: "Team 2", to: "/org" },
    { kind: t("approvals.related.org"), label: `Team 3 (${t("orgPropose.diff.chip.dissolved")})`, to: "/org" },
    { kind: "Org change", label: t("approvals.openSource"), to: "/org/changes/$id" },
  ]);
});
