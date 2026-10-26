import { tg } from "@console/i18n/gallery";
import { TimelineLanes } from "../../ui/timeline-lanes/timeline-lanes";
import { ActorBadge } from "../../ui/timeline-lanes/actor-badge";
import { Section } from "../Section";

export const order = 60;

export default function TimelineEntry() {
  const pagedEvents = Array.from({ length: 2000 }, (_, i) => ({ key: `paged-${i}`, date: "2026-10-21", title: tg("timeline.event", { number: i + 1 }) }));
  return (
    <Section title={tg("section.timeline")}>
      <TimelineLanes
        items={[
          { key: "1", date: "2026-09-01", title: tg("timeline.transfer"), detail: tg("timeline.transferReason"), meta: <ActorBadge kind="OPS_ACCOUNT" /> },
          { key: "2", date: "2026-09-15", title: tg("timeline.leave"), meta: <ActorBadge kind="OPS_ACCOUNT" breakGlass /> },
          { key: "3", date: "2026-09-30", title: tg("timeline.long"), detail: tg("sample.longName"), meta: <ActorBadge kind="SUPPORT_OPERATOR" /> },
        ]}
      />
      <div className="gallery__block">
        <TimelineLanes items={pagedEvents} />
      </div>
    </Section>
  );
}
