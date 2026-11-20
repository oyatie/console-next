// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Meter } from "./meter";

export const order = 86;

/** Continuous retention bars and segmented half-day leave meters across rest, warn, pending, and partial states. */
export default function MeterGallery() {
  return (
    <section className="card gallery__section" data-meter-gallery="">
      <h2 className="toolbar__title">{tg("section.meter")}</h2>
      <div className="row">
        <Meter value={75} max={100} label={tg("meter.usage")} />
        <Meter value={90} max={100} label={tg("meter.warnUsage")} warn />
        <Meter value={0} max={0} label={tg("meter.emptyUsage")} />
        <Meter value={100} max={100} label={tg("meter.fullUsage")} />
      </div>
      <div className="gallery__phone">
        <Meter
          value={5.5}
          pending={1}
          max={15}
          cells={30}
          label={t("people.field.leave")}
          valueText={tg("meter.leaveValueText")}
        />
      </div>
      <div className="gallery__phone">
        <Meter
          value={12.25}
          pending={1.5}
          max={15}
          cells={30}
          warn
          label={tg("meter.leaveWarnLabel")}
          valueText={tg("meter.leaveWarnText")}
        />
      </div>
    </section>
  );
}
