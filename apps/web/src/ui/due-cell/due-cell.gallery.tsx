// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { DueCell } from "./due-cell";

export const order = 90;

/** Remaining-days readout across overdue, today, near, far, and undated severities. */
export default function DueCellGallery() {
  return (
    <section className="card gallery__section" data-due-cell-gallery="">
      <h2 className="toolbar__title">{t("home.inbox.column.due")}</h2>
      <div className="row">
        <DueCell days={-3} />
        <DueCell days={0} />
        <DueCell days={2} />
        <DueCell days={20} />
        <DueCell days={null} />
      </div>
    </section>
  );
}
