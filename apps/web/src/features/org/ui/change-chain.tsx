import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { APPROVAL_ROLE, label } from "../../../lib/labels";
import { ChainStepper, type ChainStep } from "../../../ui/chain-stepper/chain-stepper";

type Detail = components["schemas"]["OrgChangeDetail"];

/**
 * The approval chain by role, with the decider's name once decided. Steps the change never reached after a
 * rejection or a cancellation read "not reached", not "waiting" (D5). Named approvers wait on BW-01.
 */
export function ChangeChain({ d }: { d: Detail }) {
  const decided = d.approvalSteps.filter((s) => s.decision === "APPROVED").length;
  const ended = d.status === "REJECTED" || d.status === "CANCELLED";
  const current = d.status === "IN_APPROVAL" ? d.approvalSteps.find((s) => s.decision === "PENDING")?.id : undefined;
  const steps: ChainStep[] = d.approvalSteps.map((s) => {
    const role = label(APPROVAL_ROLE, s.roleKey);
    if (s.decision !== "PENDING")
      return {
        key: s.id,
        who: s.decidedByName ? t("orgChange.chain.decidedBy", { role, name: s.decidedByName }) : role,
        state: s.decision === "APPROVED" ? "done" : "failed",
        meta: <>{t(`orgChange.chain.${s.decision}`, { at: fmtDateTime(s.decidedAt) })}{s.memo && <> · {s.memo}</>}</>,
      };
    if (s.id === current) return { key: s.id, who: role, state: "current", meta: t("orgChange.chain.current"), note: t("orgChange.turn.who") };
    return { key: s.id, who: role, state: "waiting", meta: ended ? t("orgChange.chain.skipped") : undefined };
  });
  return (
    <section className="card panel" aria-labelledby="approvals">
      <h2 id="approvals" className="panel__title" tabIndex={-1}>{t("orgChange.chain.title", { n: decided, total: d.approvalSteps.length })}</h2>
      <ChainStepper steps={steps} label={t("orgChange.chain.title", { n: decided, total: d.approvalSteps.length })} />
    </section>
  );
}
