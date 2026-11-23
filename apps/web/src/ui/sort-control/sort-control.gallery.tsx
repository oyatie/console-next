// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { SortControl } from "./sort-control";

export const order = 89;

/** Command-strip sort readout and toggle in single-field and multi-field configurations. */
export default function SortControlGallery() {
  const [singleDir, setSingleDir] = useState<"asc" | "desc">("asc");
  const [multi, setMulti] = useState<{ field: "date" | "name"; direction: "asc" | "desc" }>({
    field: "date",
    direction: "asc",
  });

  return (
    <section className="card gallery__section" data-sort-control-gallery="">
      <h2 className="toolbar__title">{t("uiLongTable.sort")}</h2>
      <div className="row">
        <SortControl
          fields={[{ id: "date", label: tg("form.date") }]}
          field="date"
          direction={singleDir}
          onChange={next => setSingleDir(next.direction)}
        />
        <SortControl
          label={`${t("uiLongTable.sort")} 2`}
          fields={[
            { id: "date", label: tg("form.date") },
            { id: "name", label: tg("col.name") },
          ]}
          field={multi.field}
          direction={multi.direction}
          onChange={setMulti}
        />
      </div>
    </section>
  );
}
