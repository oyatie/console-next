// SPDX-License-Identifier: LicenseRef-Proprietary
import { useId, useRef, useState } from "react";
import { t } from "@console/i18n";
import { Button } from "../button/button";
import s from "./decision-pane.module.css";

/**
 * Side-by-side approval decision area for record and document panes: comment is optional on approve and required on
 * reject or request-changes, preserving typed text across validation and conflict alerts.
 */
export function DecisionPane({
  opinion,
  onOpinionChange,
  onApprove,
  onReject,
  onReturn,
  approveLabel,
  rejectLabel,
  returnLabel,
  pending,
}: {
  /** Controlled comment string preserved across attempts and server errors. */
  opinion: string;
  /** Updates the controlled comment string. */
  onOpinionChange: (next: string) => void;
  /** Invoked when approve is pressed (`opinion` may be empty). */
  onApprove: (opinion: string) => void;
  /** Invoked when reject is pressed with a non-empty `opinion`. */
  onReject: (opinion: string) => void;
  /** Optional request-changes callback; rendered only when the record kind supports returning. */
  onReturn?: (opinion: string) => void;
  /** Custom approve button label; defaults to `uiWorklist.approve`. */
  approveLabel?: string;
  /** Custom reject button label; defaults to `uiWorklist.reject`. */
  rejectLabel?: string;
  /** Custom request-changes button label; defaults to `uiWorklist.return`. */
  returnLabel?: string;
  /** In-flight action (`"approve"`, `"reject"`, or `"return"`). */
  pending?: "approve" | "reject" | "return";
}) {
  const id = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [missingReason, setMissingReason] = useState(false);
  const busy = pending !== undefined;
  const trimmed = opinion.trim();
  const invalid = missingReason && trimmed.length === 0;
  const errorId = `${id}-error`;

  const requireReasonThen = (act: (memo: string) => void) => {
    if (trimmed.length === 0) {
      setMissingReason(true);
      inputRef.current?.focus();
      return;
    }
    setMissingReason(false);
    act(trimmed);
  };

  return (
    <div className={s.pane} data-decision-pane="">
      <label htmlFor={id} className={s.label}>
        {t("uiWorklist.opinionOptional")}
      </label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        className={s.input}
        value={opinion}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onChange={event => {
          onOpinionChange(event.target.value);
          if (event.target.value.trim().length > 0) setMissingReason(false);
        }}
      />
      {invalid ? (
        <div id={errorId} role="alert" className={s.error}>
          {t("uiWorklist.opinionRequired")}
        </div>
      ) : null}
      <div className={s.actions}>
        <Button
          size="lg"
          className={s.secondaryBtn}
          pending={pending === "reject"}
          disabled={busy && pending !== "reject"}
          onClick={() => requireReasonThen(onReject)}
        >
          {rejectLabel ?? t("uiWorklist.reject")}
        </Button>
        {onReturn ? (
          <Button
            size="lg"
            className={s.secondaryBtn}
            pending={pending === "return"}
            disabled={busy && pending !== "return"}
            onClick={() => requireReasonThen(onReturn)}
          >
            {returnLabel ?? t("uiWorklist.return")}
          </Button>
        ) : null}
        <Button
          variant="primary"
          size="lg"
          className={s.approveBtn}
          pending={pending === "approve"}
          disabled={busy && pending !== "approve"}
          onClick={() => {
            setMissingReason(false);
            onApprove(trimmed);
          }}
        >
          {approveLabel ?? t("uiWorklist.approve")}
        </Button>
      </div>
    </div>
  );
}
