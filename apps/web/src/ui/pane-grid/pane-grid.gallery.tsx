// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { Button } from "../button/button";
import { KeyValue } from "../key-value/key-value";
import { useScreenStatusBar } from "../status-bar/status-bar-store";
import { Table } from "../table";
import { PaneGrid, PaneHead } from "./pane-grid";

export const order = 88;

const ROWS = [
  { id: "r1", n: 1 },
  { id: "r2", n: 2 },
] as const;

/** Rule-divided multi-pane workspace grid with start rail, main table, bottom pane, and resizable record pane. */
export default function PaneGridGallery() {
  const [selected, setSelected] = useState<string>("r1");
  const [full, setFull] = useState(false);

  useScreenStatusBar([
    { id: "scope", content: tg("sample.company"), tone: "strong" },
    { id: "count", content: tg("table.many") },
  ]);

  return (
    <section className="card gallery__section" data-pane-grid-gallery="">
      <h2 className="toolbar__title">{t("people.panel")}</h2>
      <PaneGrid
        start={
          <>
            <PaneHead title={tg("col.unit")} meta={tg("sample.company")} level={3} />
            <KeyValue items={[{ key: "dept", label: tg("col.unit"), value: tg("sample.dept") }]} />
          </>
        }
        main={
          <>
            <PaneHead title={tg("section.tables")} meta={tg("table.many")} level={3} />
            <Table
              label={tg("table.many")}
              rows={[...ROWS]}
              rowId={row => row.id}
              selected={selected}
              onSelect={setSelected}
              columns={[
                { header: tg("col.name"), cell: row => tg("sample.person", { n: row.n }) },
                { header: tg("col.position"), cell: () => tg("sample.position") },
              ]}
            />
          </>
        }
        bottom={
          <>
            <PaneHead title={tg("section.timeline")} meta={tg("sample.site")} level={3} />
            <KeyValue items={[{ key: "line", label: tg("col.status"), value: tg("timeline.transferReason") }]} />
          </>
        }
        record={
          selected
            ? {
                id: selected,
                label: t("people.panel"),
                title: tg("sample.person", { n: selected === "r2" ? 2 : 1 }),
                meta: selected,
                openInTab: { href: "/people", label: tg("sample.person", { n: 1 }) },
                onClose: () => setSelected(""),
                footer: <Button variant="primary" size="lg" block>{tg("form.submit")}</Button>,
                children: (
                  <KeyValue
                    items={[
                      { key: "unit", label: tg("col.unit"), value: tg("sample.dept") },
                      { key: "pos", label: tg("col.position"), value: tg("sample.position") },
                    ]}
                  />
                ),
              }
            : null
        }
        full={full}
        onFull={setFull}
        onSelect={setSelected}
      />
    </section>
  );
}
