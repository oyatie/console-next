// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { ChangeRows } from "./change-rows";

export const order = 92;

/** Dense before-to-after diff rows for record panes and approval documents. */
export default function ChangeRowsGallery() {
  return (
    <section className="card gallery__section" data-change-rows-gallery="">
      <h2 className="toolbar__title">{t("uiWorklist.changes")}</h2>
      <ChangeRows
        items={[
          { id: "r1", subject: tg("sample.dept"), before: tg("sample.position"), after: tg("sample.team") },
          { id: "r2", subject: tg("sample.site"), before: tg("sample.company"), after: tg("sample.dept") },
        ]}
      />
    </section>
  );
}
