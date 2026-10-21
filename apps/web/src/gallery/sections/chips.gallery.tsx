import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Chip } from "../../ui/chip";
import { EMPLOYEE_STATUS, label } from "../../lib/labels";
import { Section } from "../Section";

export const order = 10;

export default function Chips() {
  return (
    <Section title={tg("section.chips")}>
      <div className="row">
        <Chip tone="ok">{label(EMPLOYEE_STATUS, "ACTIVE")}</Chip>
        <Chip tone="info">{label(EMPLOYEE_STATUS, "ON_LEAVE")}</Chip>
        <Chip tone="warn">{label(EMPLOYEE_STATUS, "UNKNOWN")}</Chip>
        <Chip tone="danger">{t("enum.stepDecision.REJECTED")}</Chip>
        <Chip>{label(EMPLOYEE_STATUS, "EXITED")}</Chip>
        <Chip tone="info">{tg("sample.teamLong")}</Chip>
      </div>
    </Section>
  );
}
