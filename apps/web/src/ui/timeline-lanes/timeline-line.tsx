import type { ReactNode } from "react";
import { t } from "@console/i18n";
import { ActorBadge } from "./actor-badge";
import { FieldDiff, type FieldChange } from "./field-diff";
import { RetentionChip, type Retention } from "./retention-chip";
import type { ActorKind, TimelineState } from "./states";
import { TimelineRow } from "./timeline-row";
const separator = " · ";

export type TimelineLineProps = {
  id?: string;
  date: string;
  state: TimelineState;
  title?: ReactNode;
  actor?: string;
  actorKind?: ActorKind;
  recordedAt?: string;
  reason?: string;
  fields?: readonly FieldChange[];
  retention?: Retention;
  /** Already-authorized next actions, including the request outcome link. */
  actions?: ReactNode;
  liveNew?: boolean;
};

/** A history row; restricted and destroyed rows never mount supplied values or actions. */
export function TimelineLine({ id, date, state, title, actor, actorKind, recordedAt, reason, fields, retention, actions, liveNew }: TimelineLineProps) {
  const valuesVisible = state !== "restricted" && state !== "destroyed";
  const actorLabel = actor ?? (actorKind === "SYSTEM" ? t("timeline.system") : undefined);
  return <TimelineRow id={id} date={date} lifecycle={state} highlight={liveNew}
    tone={state === "scheduled" ? "info" : "neutral"}
    title={<>
        <span>{t(`timeline.state.${state}`)}</span>
        {valuesVisible && title != null && separator}
        {valuesVisible && title}
        {state !== "emergency" && state !== "operator" && <ActorBadge kind={actorKind} />}
        {liveNew && <span className="sr-only">{t("timeline.liveNew")}</span>}
    </>}
    meta={state !== "destroyed" && (actorLabel || recordedAt) ? <>{actorLabel}{actorLabel && recordedAt && separator}{recordedAt}</> : undefined}
    detail={valuesVisible && reason ? t("timeline.reason", { reason }) : undefined}
    verbs={valuesVisible ? actions : undefined}>
      {valuesVisible && fields && <FieldDiff fields={fields} corrected={state === "corrected"} />}
      {valuesVisible && retention && <RetentionChip retention={retention} />}
  </TimelineRow>;
}
