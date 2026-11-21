// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { useCommand } from "../../../lib/react/command";
import { decideApproval, type ApprovalDecision } from "../api";

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
