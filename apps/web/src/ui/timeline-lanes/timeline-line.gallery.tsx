import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { fmtDate, fmtDateTime } from "@console/i18n/format";
import { TimelineLine } from "./timeline-line";
import { timelineStates } from "./states";
import { RetentionChip } from "./retention-chip";
import s from "./timeline-lanes.module.css";

export const order = 219;

export default function TimelineLineGallery() {
  return <section className="card gallery__section" id="gallery-timeline-line">
    <h2 className="toolbar__title">{t("uiTimelineLanes.name")}</h2>
    <ol className={s.list}>
      {timelineStates.map((state) => <TimelineLine key={state} id={`gallery-timeline-${state}`} state={state}
        date={fmtDate("2026-10-09")} title={tg("sample.team")}
        actor={state === "effectuated" ? undefined : tg("sample.person", { n: 1 })} recordedAt={fmtDateTime("2026-10-09T05:06:00Z")}
        actorKind={state === "emergency" ? "OPS_ACCOUNT" : state === "operator" ? "SUPPORT_OPERATOR" : state === "effectuated" ? "SYSTEM" : "TENANT_USER"}
        reason={tg("timeline.transferReason")} liveNew={state === "changed"}
        fields={[
          { field: "department", label: t("orgUnit.kind"), before: tg("sample.dept"), after: tg("sample.team") },
          { field: "note", label: tg("form.note"), before: null, after: tg("timeline.long").repeat(4) },
          { field: "private", label: t("timeline.restricted"), masked: true },
        ]}
      />)}
    </ol>
    <div className={s.retention}>
      <span id="gallery-retention-retained"><RetentionChip retention={{ state: "retained", until: "2029-10-09" }} /></span>
      <span id="gallery-retention-due"><RetentionChip retention={{ state: "due" }} /></span>
      <span id="gallery-retention-hold"><RetentionChip retention={{ state: "hold", reason: tg("timeline.transferReason") }} /></span>
      <span id="gallery-retention-destroyed"><RetentionChip retention={{ state: "destroyed" }} /></span>
    </div>
  </section>;
}
