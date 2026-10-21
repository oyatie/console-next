import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ChainStepper, type ChainStep } from "./chain-stepper";
import { DeadlineChip } from "../deadline-chip/deadline-chip";

export const order = 211;

const who = (n: number) => `${tg("sample.person", { n })} · ${tg("sample.position")}`;
const steps: ChainStep[] = [
  { key: "1", who: who(1), state: "done", meta: t("enum.stepDecision.APPROVED") },
  { key: "2", who: who(2), state: "done", meta: t("enum.stepDecision.APPROVED") },
  { key: "3", who: who(3), state: "current", meta: t("uiChainStepper.mine"), deadline: <DeadlineChip severity="far" days={3} />, note: t("org.change.submit.consequence", { code: "OC-2026-0418" }) },
  { key: "4", who: who(4), state: "waiting" },
];

export default function ChainSteppers() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiChainStepper.name")}</h2>
      <ChainStepper steps={steps} />
      <ChainStepper steps={[{ key: "1", who: who(5), state: "done" }, { key: "2", who: who(6), state: "failed", meta: t("enum.stepDecision.REJECTED") }]} />
    </section>
  );
}
