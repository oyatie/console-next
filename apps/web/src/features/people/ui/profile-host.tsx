import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { Receipt } from "../../../ui/receipt/receipt";
import type { Resolution } from "../api";
import { IdentitySheet } from "./identity-sheet";
import { ProfileSheet, type ProfileDone } from "./profile-sheet";

type Detail = components["schemas"]["EmployeeDetail"];
type Outcome = { message: string; pending: boolean; review: boolean };
const corrected = (out: ProfileDone): Outcome =>
  out.kind === "requested"
    ? { message: t("profile.receipt.requested"), pending: true, review: false }
    : { message: t(out.out.pending_request ? "profile.receipt.pending" : "profile.receipt.corrected", { count: out.out.applied.length }), pending: Boolean(out.out.pending_request), review: out.out.review_required };
const resolved = (out: Resolution): Outcome => ({
  message: t(out.pending_request ? "identity.receipt.pending" : out.verdict === "SAME" ? "identity.receipt.merged" : "identity.receipt.different"),
  pending: Boolean(out.pending_request),
  review: out.review_required,
});

/**
 * The record's own corrections (BW-18) and requests to HR (BW-17), as sheets over the record; the last outcome heads
 * the page: applied, waiting for a second person (with the way to the request list), or applied and flagged for review.
 */
export function ProfileHost({ d, act, onClose }: { d: Detail; act?: string; onClose: () => void }) {
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const done = (o: Outcome) => {
    setOutcome(o);
    onClose();
  };
  return (
    <>
      {outcome && (
        <Receipt
          state="recorded"
          message={[outcome.message, outcome.review ? t("profile.receipt.review") : ""].filter(Boolean).join(" ")}
          actions={outcome.pending ? <Link className="btn btn--ghost" to="/people/requests">{t("profile.receipt.requests")}</Link> : undefined}
        />
      )}
      {(act === "profile" || act === "request") && <ProfileSheet key={act} d={d} mode={act === "profile" ? "correct" : "request"} onClose={onClose} onDone={(out) => done(corrected(out))} />}
      {act === "identity" && <IdentitySheet d={d} onClose={onClose} onDone={(out) => done(resolved(out))} />}
    </>
  );
}
