import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Chip } from "../../ui/chip";
import { SourceChip } from "../../ui/source-chip";
import { DeadlineChip } from "../../ui/deadline-chip/deadline-chip";
import { Count } from "../../ui/count/count";
import { Kbd } from "../../ui/kbd/kbd";
import { Meter } from "../../ui/meter/meter";
import { ActorBadge } from "../../ui/timeline-lanes/actor-badge";
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
        <ActorBadge kind="OPS_ACCOUNT" />
        <ActorBadge kind="OPS_ACCOUNT" breakGlass />
        <ActorBadge kind="SUPPORT_OPERATOR" />
        <SourceChip source="document" />
        <DeadlineChip severity="due" days={5} />
        <Count n={42} />
        <Kbd keys="⌘K" />
        <Meter value={75} max={100} label={tg("meter.usage")} />
      </div>
    </Section>
  );
}
