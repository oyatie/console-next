// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { decideApproval, type ApprovalDecision, type ApprovalDocument } from "../api";

type Receipt = Awaited<ReturnType<typeof decideApproval>>;

/** What was recorded, from the decision and the document's status after it. */
const receiptText = (r: Receipt) =>
  r.decision === "REJECTED"
    ? t("approvals.receipt.rejected")
    : r.decision === "APPROVED"
      ? t(r.status === "IN_APPROVAL" ? "approvals.receipt.approvedNext" : "approvals.receipt.approvedFinal")
      : t("approvals.receipt.recorded");

export function useApprovalDecisionCommand(documentId: string, onReceipt?: (text: string) => void) {
  const [localReceipt, setLocalReceipt] = useState<string>();
  const command = useCommand({
    run: (body: ApprovalDecision, key: string) => decideApproval(documentId, body, key),
    invalidates: ["/api/v1/approvals"],
    settle: true,
    onSuccess: result => {
      const text = receiptText(result);
      setLocalReceipt(text);
      onReceipt?.(text);
    },
    announce: receiptText,
  });
  return { command, localReceipt };
}

/**
 * Whether the server offers a decision on `d`, or did on an earlier read while `d` has stayed the document shown;
 * showing no document or another one ends that. Hosts keep the panel, and the panel keeps the card's place, that
 * long, so a later read that withdraws the decision can be said where the card was.
 */
export function useDecisionOffered(d: ApprovalDocument | undefined) {
  const [heldId, setHeldId] = useState<string>();
  const id = d?.my_actions.kind === "approve" && d.my_actions.reject ? d.id : heldId === d?.id ? heldId : undefined;
  if (id !== heldId) setHeldId(id);
  return id !== undefined;
}
