// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import type { OrgChangeDetail, SoleHolderDecision, SoleHolderException } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { ORG_READS } from "../../../reference/org/api";
import { Card } from "../../../ui/card/card";
import { KeyValue } from "../../../ui/key-value/key-value";
import { Button } from "../../../ui/button/button";
import { Banner } from "../../../ui/banner/banner";
import { ExceptionMark, OverrideSheet } from "../../../ui/override-sheet/override-sheet";
import { describeOp, reasonText, type Names } from "../present";
import { decideSoleHolder } from "../api/sole-holder";
import type { Note } from "./use-note";

export function SoleHolderReview({ exception }: { exception: SoleHolderException }) {
  return <p><ExceptionMark /> {t("orgChange.sole.review", { count: exception.notice_count, at: fmtDateTime(exception.review_due_at) })}</p>;
}

/** Server-offered case-B path. The browser never infers eligibility from roles or the absence of another person. */
export function SoleHolderDecisionCard({ d, offer, n, onNote, onReopen }: {
  d: OrgChangeDetail;
  offer: SoleHolderDecision;
  n: Names;
  onNote: (note: Note) => void;
  onReopen: () => void;
}) {
  const [open, setOpen] = useState(false);
  const run = useCommand({
    run: (_: void, key: string) => decideSoleHolder(d.id, offer, key),
    invalidates: ORG_READS,
    onSuccess: result => {
      setOpen(false);
      onNote({ message: t("orgChange.sole.recorded"), hold: true,
        actions: result.sole_holder_decision && <Button onClick={onReopen}>{t("orgChange.sole.next")}</Button> });
    },
  });
  const cancelled = run.error instanceof Error && run.error.message === "passkey_cancelled";
  return <Card label={t("orgChange.next.title")}>
    <Button variant="primary" onClick={() => setOpen(true)}>{t("orgChange.sole.open")}</Button>
    <OverrideSheet open={open} title={t("orgChange.sole.open")} risk="high"
      rule={{ title: t("orgChange.sole.rule"), detail: t("orgChange.sole.review", { count: offer.notice_count, at: fmtDateTime(offer.review_due_at) }) }}
      route={{ kind: "sole-holder", binding: { action: "EXCEPTION_DECIDE", hash: offer.payload_hash.slice(0, 12) }, notified: offer.notice_count }}
      reason={<>
        <ol>{d.proposal.map((op, i) => <li key={i}>{describeOp(op, n)}</li>)}</ol>
        <blockquote>{reasonText(d)}</blockquote>
        <KeyValue items={[
          { key: "date", label: t("orgChange.date"), value: fmtDate(d.effectiveDate) },
          { key: "people", label: t("orgChange.headcount"), value: t("orgChange.headcount.value", { count: d.headcount }) },
        ]} />
        {cancelled ? <Banner tone="info" live="polite">{t("orgChange.sole.cancelled")}</Banner>
          : <CommandError error={run.error} own={code => code === "step_up_failed" ? t("orgChange.sole.stepUpFailed")
            : code === "lifecycle.refuse.stale_version" ? t("orgChange.sole.offerChanged") : undefined} />}
      </>}
      reasonComplete commitLabel={t("orgChange.sole.approve")} pending={run.isPending}
      onCommit={() => run.mutate(undefined)} onClose={() => setOpen(false)} />
  </Card>;
}
