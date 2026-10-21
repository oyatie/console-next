import { Link } from "@tanstack/react-router";
import { FileText } from "lucide-react";
import { t } from "@console/i18n";
import { Receipt } from "../../../ui/receipt/receipt";
import { receiptAction } from "../../../ui/receipt/receipt-action";
import { noteChange, useChangeNote } from "./use-change-note";

/**
 * The receipt a change made from the chart leaves on the chart (org-19): the user stays where they were working, sees
 * what was recorded, and opens the record from here. It stays until dismissed or replaced; nothing times out.
 */
export function ChangeReceipt() {
  const n = useChangeNote();
  if (!n) return null;
  return (
    <Receipt
      state="applied"
      message={n.message}
      onDismiss={() => noteChange()}
      actions={
        <Link to="/org/changes/$id" params={{ id: n.id }} className={receiptAction} onClick={() => noteChange()}>
          <FileText size={14} aria-hidden />
          {t("orgChange.receipt.open", { code: n.code })}
        </Link>
      }
    />
  );
}
