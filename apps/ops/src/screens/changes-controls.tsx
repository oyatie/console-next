// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { COPY } from "../copy";
import type { OpsCmdHandOff } from "../lib/api";
import { hasOpsAction } from "../lib/auth";
import { useChangesCanaryMutation, useChangesFreezeMutation, useChangesRollbackMutation } from "../lib/mutations";
import { useOpsContext } from "../lib/ops-context";
import { CmdReceipt } from "../ui/cmd-receipt";
import { DisabledReason } from "../ui/disabled-reason";
import { InlineError } from "../ui/inline-error";
import s from "./changes-screen.module.css";

export function ChangesControls({
  isFrozen,
  defaultDigest,
}: {
  isFrozen: boolean;
  defaultDigest: string;
}) {
  const { me } = useOpsContext();
  const canFreeze = hasOpsAction(me, "change.request.freeze");
  const canUnfreeze = hasOpsAction(me, "change.request.unfreeze");
  const canHold = hasOpsAction(me, "change.request.canary-hold");
  const canPromote = hasOpsAction(me, "change.request.canary-promote");
  const canAbort = hasOpsAction(me, "change.request.canary-abort");
  const canRollback = hasOpsAction(me, "change.request.rollback");

  const freezeMut = useChangesFreezeMutation();
  const canaryMut = useChangesCanaryMutation();
  const rollbackMut = useChangesRollbackMutation();

  const [reason, setReason] = useState("");
  const [digestOverride, setDigestOverride] = useState<string | null>(null);
  const digest = digestOverride ?? defaultDigest;
  const [receipt, setReceipt] = useState<OpsCmdHandOff | null>(null);

  const activeError = freezeMut.error ?? canaryMut.error ?? rollbackMut.error;
  const anyPending = freezeMut.isPending || canaryMut.isPending || rollbackMut.isPending;

  const missingGrants: string[] = [];
  if (isFrozen && !canUnfreeze) missingGrants.push("change.request.unfreeze");
  else if (!isFrozen && !canFreeze) missingGrants.push("change.request.freeze");
  if (!canHold) missingGrants.push("change.request.canary-hold");
  if (!canPromote) missingGrants.push("change.request.canary-promote");
  if (!canAbort) missingGrants.push("change.request.canary-abort");
  if (!canRollback) missingGrants.push("change.request.rollback");

  return (
    <section className={s.band} aria-labelledby="changes-controls">
      <div className={s.bandHead}>
        <h2 id="changes-controls" className={s.bandTitle}>{COPY.changes.controlsTitle}</h2>
      </div>
      <div className={s.controlsBody}>
        <div className={s.formGrid}>
          <label className={s.fieldLabel}>
            <span>{COPY.changes.reasonLabel}</span>
            <input
              type="text"
              className="field-input--form"
              placeholder={COPY.changes.reasonPlaceholder}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className={s.fieldLabel}>
            <span>{COPY.changes.digestLabel}</span>
            <input
              type="text"
              className="field-input--form"
              value={digest}
              onChange={(e) => setDigestOverride(e.target.value)}
            />
          </label>
        </div>

        <div className={s.btnRow}>
          <button
            type="button"
            className="btn btn--sm"
            disabled={anyPending || (isFrozen ? !canUnfreeze : !canFreeze)}
            onClick={() =>
              freezeMut.mutate(
                { freeze: !isFrozen, reason: reason.trim() },
                { onSuccess: (res) => setReceipt(res.action) },
              )
            }
          >
            {isFrozen ? COPY.changes.unfreezeBtn : COPY.changes.freezeBtn}
          </button>

          <button
            type="button"
            className="btn btn--sm"
            disabled={anyPending || !canHold}
            onClick={() =>
              canaryMut.mutate(
                { decision: "hold", reason: reason.trim() },
                { onSuccess: (res) => setReceipt(res.action) },
              )
            }
          >
            {COPY.changes.canaryHoldBtn}
          </button>

          <button
            type="button"
            className="btn btn--sm btn--primary"
            disabled={anyPending || !canPromote}
            onClick={() =>
              canaryMut.mutate(
                { decision: "promote", reason: reason.trim() },
                { onSuccess: (res) => setReceipt(res.action) },
              )
            }
          >
            {COPY.changes.canaryPromoteBtn}
          </button>

          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={anyPending || !canAbort}
            onClick={() =>
              canaryMut.mutate(
                { decision: "abort", reason: reason.trim() },
                { onSuccess: (res) => setReceipt(res.action) },
              )
            }
          >
            {COPY.changes.canaryAbortBtn}
          </button>

          <button
            type="button"
            className="btn btn--sm btn--danger"
            disabled={anyPending || !canRollback}
            onClick={() =>
              rollbackMut.mutate(
                { digest: digest.trim(), reason: reason.trim() },
                { onSuccess: (res) => setReceipt(res.action) },
              )
            }
          >
            {COPY.changes.rollbackBtn}
          </button>
        </div>

        {missingGrants.length > 0 ? (
          <DisabledReason
            reason={
              missingGrants.length === 5
                ? COPY.o0.reasons.actionDenied
                : `Requires ${missingGrants.join(", ")}`
            }
          />
        ) : null}
        {activeError ? <InlineError error={activeError} /> : null}
        {receipt ? <CmdReceipt action={receipt} /> : null}
      </div>
    </section>
  );
}
