import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { GateRail } from "../../ui/gate-rail";
import { Section } from "../Section";

export const order = 50;

export default function Rails() {
  const steps = (["DRAFT", "PRECHECKED", "IN_APPROVAL", "APPROVED", "APPLIED"] as const).map((key) => ({ key, label: t(`org.change.step.${key}`) }));
  return (
    <Section title={tg("section.rails")}>
      <GateRail steps={steps} current="DRAFT" />
      <GateRail steps={steps} current="IN_APPROVAL" />
      <GateRail steps={steps} current="IN_APPROVAL" failed />
      <GateRail steps={steps} current="APPLIED" />
    </Section>
  );
}
