import type { ReactNode } from "react";
import { Check, CheckCircle2, Loader2, SearchCheck, Undo2, X } from "lucide-react";
import { t } from "@console/i18n";
import s from "./receipt.module.css";

/**
 * What an action did, in the order it happens (components.html §11, post-decision-receipt-and-advance):
 * - `draft`: a local change not sent yet; the only state with undo.
 * - `sending`: sent, no record yet. Nothing shows as done (no optimistic success).
 * - `recorded`: the server's receipt. `actions` holds the audit link, the server's follow-up verbs
 *   (change, withdraw) and any open-next link, which goes here, away from the primary decision button.
 * - `checking`: the response was lost; the caller looks the request up again with the same key.
 * - `applied`: a setup change the server applied at once and can put back (spec D18): it stays until dismissed or
 *   replaced, with undo (the server's undo, not a local one); without `onUndo` once it has been undone.
 * Keep one Receipt mounted and change its state: the region is `role="status"` throughout, so each
 * change is announced politely. Nothing here times out.
 * `placement="docked"` (record screens, §5): fixed at the foot beside the rail, out of the flow, so a receipt landing
 * never pushes the record under the pointer.
 */
type Placement = { placement?: "inline" | "docked" };
export type ReceiptProps = Placement & (
  | { state: "draft"; message: string; onUndo: () => void }
  | { state: "sending"; message: string }
  | { state: "recorded"; message: string; meta?: ReactNode; actions?: ReactNode }
  | { state: "checking"; message?: string }
  | { state: "applied"; message: string; onUndo?: () => void; onDismiss: () => void; undoing?: boolean; actions?: ReactNode });

export function Receipt(props: ReceiptProps) {
  return (
    <div role="status" className={props.placement === "docked" ? `${s.region} ${s.docked}` : s.region}>
      <Body {...props} />
    </div>
  );
}

function Body(props: ReceiptProps) {
  switch (props.state) {
    case "draft":
      return (
        <div className={s.toast}>
          <span className={s.tag}>{t("uiReceipt.draft")}</span>
          <span className={s.grow}>{props.message}</span>
          <button type="button" className={s.undo} onClick={props.onUndo}>
            <Undo2 size={14} aria-hidden />
            {t("uiReceipt.undo")}
          </button>
        </div>
      );
    case "sending":
      return (
        <div className={`${s.card} ${s.pending}`}>
          <p className={s.top}><Loader2 className={s.icon} size={16} aria-hidden />{props.message}</p>
          <p className={s.meta}>{t("uiReceipt.sending")}</p>
        </div>
      );
    case "recorded":
      return (
        <div className={s.card}>
          <p className={s.top}><CheckCircle2 className={s.icon} size={16} aria-hidden />{props.message}</p>
          <p className={s.meta}>
            <span className={s.badge}>{t("uiReceipt.recorded")}</span>
            {props.meta}
          </p>
          {props.actions != null && <div className={s.actions}>{props.actions}</div>}
        </div>
      );
    case "applied":
      return (
        <div className={s.toast}>
          <Check size={16} aria-hidden />
          <span className={s.grow}>{props.message}</span>
          {props.onUndo && (
            <button type="button" className={s.undo} onClick={props.onUndo} disabled={props.undoing}>
              <Undo2 size={14} aria-hidden />
              {t("uiReceipt.undoApplied")}
            </button>
          )}
          {props.actions}
          <button type="button" className={s.undo} onClick={props.onDismiss} aria-label={t("uiReceipt.dismiss")}>
            <X size={14} aria-hidden />
          </button>
        </div>
      );
    case "checking":
      return (
        <div className={`${s.card} ${s.unknown}`}>
          <p className={s.top}><SearchCheck className={s.icon} size={16} aria-hidden />{props.message ?? t("uiReceipt.checking.title")}</p>
          <p className={s.meta}>{t("uiReceipt.checking")}</p>
        </div>
      );
  }
}
