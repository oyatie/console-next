import { t } from "@console/i18n";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { tg } from "@console/i18n/gallery";
import { Chip } from "../chip";
import { TimelineLanes } from "./timeline-lanes";

export const order = 218;

/** A scheduled record with its verbs above today, a just-recorded (highlighted) record and a withdrawn one below. */
export default function TimelineLanesGallery() {
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{t("uiTimelineLanes.name")}</h2>
      <TimelineLanes
        labels={{ upcoming: t("enum.lifecycleState.SCHEDULED"), today: `${t("uiDate.today")} · ${fmtDate("2026-10-02")}`, past: t("enum.lifecycleState.APPLIED") }}
        upcoming={[{
          key: "s",
          id: "gallery-lane-s",
          date: fmtDate("2026-11-02"),
          tone: "info",
          title: tg("timeline.transfer"),
          state: <Chip tone="info">{t("enum.lifecycleState.SCHEDULED")}</Chip>,
          meta: `${tg("sample.person", { n: 1 })} · ${fmtDateTime("2026-10-02T08:45:00Z")}`,
          verbs: <button type="button" className="btn btn--ghost btn--danger">{t("people.event.cancel", { action: t("enum.lifecycleEvent.TRANSFER") })}</button>,
        }]}
        past={[
          { key: "a", id: "gallery-lane-a", date: fmtDate("2026-10-01"), tone: "ok", title: tg("timeline.leave"), detail: tg("timeline.transferReason"), highlight: true },
          { key: "c", date: fmtDate("2026-09-30"), title: tg("timeline.long"), state: <Chip>{t("enum.lifecycleState.CANCELLED")}</Chip>, struck: true },
        ]}
      />
    </section>
  );
}
