import { tg } from "@console/i18n/gallery";
import { Timeline } from "../../ui/timeline";
import { Section } from "../Section";

export const order = 60;

export default function TimelineEntry() {
  return (
    <Section title={tg("section.timeline")}>
      <Timeline
        items={[
          { key: "1", at: "2026-09-01T01:00:00Z", title: tg("timeline.transfer"), detail: tg("timeline.transferReason") },
          { key: "2", at: "2026-09-15T05:30:00Z", title: tg("timeline.leave") },
          { key: "3", at: "2026-09-30T08:45:00Z", title: tg("timeline.long"), detail: tg("sample.longName") },
        ]}
      />
    </Section>
  );
}
