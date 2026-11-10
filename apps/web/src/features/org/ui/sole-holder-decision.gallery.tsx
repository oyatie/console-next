// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import type { OrgChangeDetail, SoleHolderDecision } from "@console/api/pending";
import { Section } from "../../../gallery/Section";
import { SoleHolderDecisionCard, SoleHolderReview } from "./sole-holder-decision";

export const order = 154;
const offer: SoleHolderDecision = {
  step_id: "00000000-0000-4000-8000-000000000002", expected_version: "17", payload_hash: "a".repeat(64),
  notice_count: 2, review_due_at: "2026-11-09T03:00:00Z",
};

export default function SoleHolderDecisionGallery() {
  const d: OrgChangeDetail = {
    id: "00000000-0000-4000-8000-000000000001", code: "OC-2026-0001", kind: "NEW", status: "IN_APPROVAL",
    target: { kind: "ORG_UNIT", ref: "00000000-0000-4000-8000-000000000004", label: tg("sample.dept") }, reason: "NEW", effectiveDate: "2026-11-08",
    headcount: 0, siteCount: 0, teamCount: 0, draftedBy: "00000000-0000-4000-8000-000000000003", draftedByName: tg("sample.person", { n: 1 }),
    createdAt: "2026-11-08T03:00:00Z", updatedAt: "2026-11-08T03:00:00Z",
    proposal: [{ op: "CREATE_ORG_UNIT", kind: "DEPARTMENT", parentId: null, name: tg("sample.dept") }],
    approvalSteps: [], settlementItems: [], events: [],
  };
  return <Section title={t("orgChange.sole.open")}>
    <SoleHolderDecisionCard d={d} offer={offer} n={{ unit: () => tg("sample.company"), region: () => undefined, branch: () => undefined }} onNote={() => {}} onReopen={() => {}} />
    <SoleHolderReview exception={{ id: d.id, notice_count: offer.notice_count, review_due_at: offer.review_due_at }} />
  </Section>;
}
