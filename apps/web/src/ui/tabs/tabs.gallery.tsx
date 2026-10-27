// SPDX-License-Identifier: LicenseRef-Proprietary
import { t } from "@console/i18n";
import { tg } from "@console/i18n/gallery";
import { tabClass } from "./tab-class";
import { TabCount, TabNav, Tabs } from "./tabs";
import { PageTabs } from "./page-tabs";
import { PageHead } from "../page-head/page-head";
import { useTabSearch } from "../../lib/react/use-tab-search";
import { QueryState } from "../../lib/react/query-state";
import { SupportReference } from "../../lib/react/support-reference";
import { EmptyState } from "../empty-state";

export const order = 126;

/** URL views, panel read states, long labels and large counts; route links share the same look. */
export default function TabsGallery() {
  const longItems = Array.from({ length: 8 }, (_, n) => ({ id: `long-${n}`, label: `${tg("sample.teamLong")} ${n + 1}`, count: 2000 }));
  const long = useTabSearch(longItems);
  const unavailableItems = [{ id: "list", label: tg("tabs.list") }, { id: "unavailable", label: tg("tabs.outline"), disabledReason: tg("tabs.unavailableWhy") }];
  const unavailable = useTabSearch(unavailableItems);
  const items = [
    { id: "chart", label: tg("tabs.chart") },
    { id: "list", label: tg("tabs.list"), count: 61 },
    { id: "outline", label: tg("tabs.outline"), count: "" },
  ];
  const search = useTabSearch(items);
  const body = { chart: "tabs.chartBody", list: "tabs.listBody", outline: "tabs.outlineBody" } as const;
  return (
    <section className="card gallery__section" data-tabs-gallery>
      <h2 className="toolbar__title">{tg("section.tabs")}</h2>
      <div data-tabs-demo="url"><PageTabs label={tg("tabs.label")} items={items} {...search} renderList={list => <PageHead band title={tg("pageHead.title")} tabs={list} />}>
        {(id) => <p className="muted">{tg(body[id as keyof typeof body])}</p>}
      </PageTabs></div>
      {(["loading", "empty", "failed", "refused"] as const).map(state => {
        const reference = <SupportReference reference={`gallery-tabs-${state}`} />;
        return <div key={state} data-tabs-demo={state}>
          <Tabs label={`${tg("tabs.label")} · ${{ loading: t("common.loading"), empty: tg("empty.title"), failed: t("common.loadFailed.title"), refused: t("common.denied.title.plain") }[state]}`} items={[{ id: "list", label: tg("tabs.list"), count: state === "empty" ? 0 : undefined }]} selected="list" onSelect={() => {}}>
            {() => state === "refused" ? <EmptyState title={t("common.denied.title.plain")} reason={t("common.denied.reason")} meta={reference} /> : <>
              <QueryState q={{ isPending: state === "loading", data: state === "empty" ? [] : undefined, error: state === "failed" ? new Error() : null, refetch: () => {} }} layout="list"
                empty={() => <EmptyState title={tg("empty.title")} reason={tg("empty.reason")} />}>{() => null}</QueryState>
              {state === "failed" && reference}
            </>}
          </Tabs>
        </div>;
      })}
      <div data-tabs-demo="long"><PageTabs label={tg("sample.teamLong")} items={longItems} {...long}>
        {() => <p>{tg("tabs.listBody")}</p>}
      </PageTabs></div>
      <div data-tabs-demo="unavailable"><PageTabs label={tg("tabs.outline")} items={unavailableItems} {...unavailable}>
        {() => <p>{tg("tabs.listBody")}</p>}
      </PageTabs></div>
      <TabNav label={tg("tabs.nav")}>
        <a href="#roles" className={tabClass} aria-current="page">{tg("tabs.roles")}<TabCount>{3}</TabCount></a>
        <a href="#grants" className={tabClass}>{tg("tabs.grants")}<TabCount>{12}</TabCount></a>
        <a href="#ready" className={tabClass}>{tg("tabs.ready")}</a>
      </TabNav>
    </section>
  );
}
