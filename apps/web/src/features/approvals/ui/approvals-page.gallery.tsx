// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Section } from "../../../gallery/Section";
import type { ApprovalDocument, ApprovalItem } from "../api";
import { ApprovalDocumentView } from "./approval-viewer";
import { ApprovalInboxView } from "./approvals-page";

export const order = 127;
const item: ApprovalItem = {
  id: "approval-gallery", box: "pending", title: tg("blocker.routeTitle"), summary: tg("blocker.routeBody"), document_no: "AP-2026-001",
  source: { key: "org_change", label: tg("section.structure") }, status: { key: "waiting", label: t("approvals.box.pending"), tone: "warn" },
  requester: { id: "account-1", name: tg("blocker.ceo"), role: tg("blocker.ceoRole") }, requested_at: "2026-11-03T01:00:00Z", due_at: "2026-11-05T01:00:00Z",
  facts: [{ key: "effective", label: tg("date.effective"), value: tg("field.lossValue") }],
  route: [{ id: "draft", label: tg("form.submit"), assignee: tg("blocker.ceo"), state: "done" }, { id: "approve", label: tg("reason.label"), assignee: tg("blocker.exec"), state: "current" }],
  viewer: { kind: "org_change", id: "change-1" },
};
const document: ApprovalDocument = {
  ...item,
  body: [{ key: "change", label: tg("blocker.routeTitle"), value: tg("blocker.routeBody") }],
  revision: 1,
  fingerprint: "sha256:approval-gallery-r1",
  consequence: tg("blocker.routeBody"),
  opinion_max: 1000,
  my_actions: { kind: "none" },
  decision_refusal: "org_change.refuse.identity_unbound",
};
export default function ApprovalsGallery() {
  const [selected, setSelected] = useState(false);
  return <Section title={t("approvals.title")}>
    <ApprovalInboxView items={[item]} sel={selected ? item.id : undefined} selected={selected ? item : undefined} record={<ApprovalDocumentView document={document} />} onSelect={() => setSelected(true)} onClose={() => setSelected(false)} />
    <ApprovalDocumentView document={document} />
  </Section>;
}
