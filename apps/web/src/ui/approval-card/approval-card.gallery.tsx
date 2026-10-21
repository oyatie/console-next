import { useState } from "react";
import { Label, TextArea, TextField } from "react-aria-components";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ApprovalCard, type ApprovalPending } from "./approval-card";
import { DeadlineChip } from "../deadline-chip/deadline-chip";

export const order = 212;

/** One card per state: deciding (the reason form opens on reject / request changes), approve blocked, and after the receipt. */
function Sample({ blocked, recorded }: { blocked?: boolean; recorded?: boolean }) {
  const [memo, setMemo] = useState("");
  const [pending, setPending] = useState<ApprovalPending>();
  const name = tg("sample.person", { n: 7 });
  const unit = tg("sample.team");
  return (
    <ApprovalCard
      eyebrow="OC-2026-0418"
      step={t("uiChainStepper.mine")}
      title={t("people.lifecycle.consequence.TRANSFER", { name, date: "2026-11-02", unit })}
      consequence={<p>{t("org.change.submit.consequence", { code: "OC-2026-0418" })}</p>}
      rejectConsequence={t("org.change.rejected.next")}
      returnConsequence={t("org.change.decide.memoHint")}
      approveLabel={t("org.change.decide.approve", { role: tg("sample.dept") })}
      rejectLabel={t("org.change.decide.reject", { role: tg("sample.dept") })}
      returnLabel={t("uiApprovalCard.return")}
      reason={() => (
        <TextField className="field" value={memo} onChange={setMemo} isRequired>
          <Label className="field__label">{t("exit.field.rejectReason")}</Label>
          <TextArea className="field__input field__area" />
        </TextField>
      )}
      reasonComplete={memo.trim() !== ""}
      onApprove={() => setPending("approve")}
      onReject={() => setPending("reject")}
      onReturn={() => setPending("return")}
      pending={pending}
      meta="10:38 · 3f9a…c2"
      approveBlocked={blocked ? t("org.change.approvals.drafterCannot") : undefined}
      progress={<DeadlineChip severity="far" days={32} />}
      receipt={recorded ? <p role="status">{t("org.change.decided.APPROVED", { role: tg("sample.dept") })}</p> : undefined}
      next={recorded ? <a className="btn" href="#approval-next">{t("home.failed.review")}</a> : undefined}
    >
      <dl className="kv">
        <dt>{t("org.change.preflight")}</dt>
        <dd>{t("org.change.preflight.clear")}</dd>
      </dl>
    </ApprovalCard>
  );
}

export default function ApprovalCards() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiApprovalCard.name")}</h2>
      <Sample />
      <Sample blocked />
      <Sample recorded />
    </section>
  );
}
