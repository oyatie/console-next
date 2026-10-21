import { useState } from "react";
import { tg } from "@console/i18n/gallery";
import { tabClass } from "./tab-class";
import { TabCount, TabNav, Tabs } from "./tabs";

export const order = 126;

/** View tabs (arrow keys select) with counts, one still loading; route tabs (links) in the same look. */
export default function TabsGallery() {
  const [view, setView] = useState("chart");
  const items = [
    { id: "chart", label: tg("tabs.chart") },
    { id: "list", label: tg("tabs.list"), count: 61 },
    { id: "outline", label: tg("tabs.outline"), count: "" },
  ];
  const body = { chart: "tabs.chartBody", list: "tabs.listBody", outline: "tabs.outlineBody" } as const;
  return (
    <section className="card gallery__section">
      <h2 className="toolbar__title">{tg("section.tabs")}</h2>
      <Tabs label={tg("tabs.label")} items={items} selected={view} onSelect={setView}>
        {(id) => <p className="muted">{tg(body[id as keyof typeof body])}</p>}
      </Tabs>
      <TabNav label={tg("tabs.nav")}>
        <a href="#roles" className={tabClass} aria-current="page">{tg("tabs.roles")}<TabCount>{3}</TabCount></a>
        <a href="#grants" className={tabClass}>{tg("tabs.grants")}<TabCount>{12}</TabCount></a>
        <a href="#ready" className={tabClass}>{tg("tabs.ready")}</a>
      </TabNav>
    </section>
  );
}
