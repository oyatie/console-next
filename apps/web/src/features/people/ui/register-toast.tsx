import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { CommandError } from "../../../lib/react/command-error";
import { buttonClass } from "../../../ui/button/button-class";
import { Receipt } from "../../../ui/receipt/receipt";
import { employeeWarningText } from "../present";
import { receipts, useReceipts } from "./use-register-receipts";
import { useUndoRegister } from "./use-register";
import s from "./register-toast.module.css";

/**
 * The newest registration as a receipt (spec §1.4 R37: bottom-left): who, and the employee number the server gave; in the setup
 * phase it can be undone (the record is deleted), otherwise it is only dismissed; it opens the record (a person starting later is not
 * on the default roster, so the receipt is the way to them).
 */
export function RegisterToast({ inline = false }: { inline?: boolean }) {
  const [last] = useReceipts();
  const undo = useUndoRegister();
  if (!last) return null;
  return (
    <div className={inline ? undefined : s.dock}>
      <Receipt
        state="applied"
        message={[t("register.saved", { name: last.name, number: last.number }), ...(last.warnings ?? []).map(employeeWarningText)].join(" · ")}
        onUndo={last.undoable ? () => undo.mutate({ id: last.id, updatedAt: last.updatedAt }, { onSuccess: () => receipts.drop(last.id) }) : undefined}
        undoing={undo.isPending}
        onDismiss={() => receipts.drop(last.id)}
        actions={<Link to="/people/$id" params={{ id: last.id }} search={{}} className={buttonClass("ghost", { size: "sm" })}>{t("register.openRecord")}</Link>}
      />
      <CommandError error={undo.error} />
    </div>
  );
}
