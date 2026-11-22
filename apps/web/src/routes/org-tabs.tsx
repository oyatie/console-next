// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useContext, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { createLazyRoute, getRouteApi, lazyRouteComponent, useRouter } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { OrgHeadSlotContext } from "../features/structure/ui/use-org-head-slot";
import { chunk } from "../lib/chunk-guard";
import { screen } from "../lib/fonts";
import { useTabSearch } from "../lib/react/use-tab-search";
import { Page } from "../ui/page/page";
import { PageHead } from "../ui/page-head/page-head";
import { PageHeadingLevel, PageScope } from "../ui/page/page-scope";
import { ExperienceSwitch } from "../ui/patterns/pattern-shell";
import { PageTabs } from "../ui/tabs/page-tabs";
import { ToggleButton } from "../ui/button/button";
import { ReadSkeleton } from "../ui/skeleton/skeleton";
import { AccessGate } from "../reference/authz/ui/access-gate";
import { readRequirement } from "./route-reads";
import { ORG_TABS, orgTab } from "./org-tab-search";
import { entitiesAt, changesQuery, entityBatchesQuery, orgBatchesQuery, orgStructureRef as structureQuery } from "../reference/entity/api";
import s from "./org-tabs.module.css";

const Chart = lazy(() => chunk(import("./org-screen")).then(m => ({ default: m.OrgScreen })));
const EntityContent = lazy(() => chunk(import("../features/entity/ui/entity-routes")).then(m => ({ default: m.EntitiesScreen })));
const ChangeContent = lazy(() => chunk(import("../features/org/ui/org-changes")).then(m => ({ default: m.OrgChanges })));
const History = lazy(() => chunk(import("../features/org-bulk/ui/history-page")).then(m => ({ default: m.HistoryPage })));
const route = getRouteApi("/app/org");

export const orgChange = createLazyRoute("/app/org/changes/$id")({
  component: lazyRouteComponent(screen(() => import("../features/org/OrgChange")), "OrgChange"),
});

/** Start the shared read behind the access gate while the list code loads. */
function Entities() {
  const { as_of, known_at, bulk } = route.useSearch();
  useQuery({ ...entitiesAt({ as_of, known_at }), enabled: !bulk });
  return <Suspense fallback={<ReadSkeleton layout="list" />}><EntityContent /></Suspense>;
}

/** Mounted reads stay behind access and never run during intent preloading. */
function Changes() {
  const { filter } = route.useSearch();
  const navigate = route.useNavigate();
  const enabled = filter === "history";
  useQuery({ ...orgBatchesQuery, enabled });
  useQuery({ ...entityBatchesQuery, enabled });
  useQuery({ ...changesQuery, enabled });
  useQuery({ ...structureQuery, enabled });
  return <Suspense fallback={<ReadSkeleton layout="list" />}><ChangeContent history={{
    chip: <ToggleButton pressed={enabled} onClick={() => void navigate({ search: q => ({ ...q, filter: "history" }), replace: true })}>{t("orgChange.list.view.history")}</ToggleButton>,
    body: <Suspense fallback={<ReadSkeleton layout="list" />}><History /></Suspense>,
  }} /></Suspense>;
}

function OrgTabsContent({ current }: { current: string }) {
  return (
    <Suspense fallback={<ReadSkeleton layout="list" />}>
      {current === ORG_TABS[1] ? <AccessGate {...readRequirement("/org/entities")} layout="list"><Entities /></AccessGate>
        : current === ORG_TABS[2] ? <AccessGate {...readRequirement("/org/changes")} layout="list"><Changes /></AccessGate> : <Chart />}
    </Suspense>
  );
}

function OrgTabsBaseline({ tabs, current }: { tabs: ReactNode; current: string }) {
  return (
    <Page floorplan="canvas" head={{ title: t("structure.title"), titleId: "structure-title", tabs }}>
      <OrgTabsContent current={current} />
    </Page>
  );
}

function OrgTabsConsole({ tabs, current }: { tabs: ReactNode; current: string }) {
  const scope = useContext(PageScope);
  const level = useContext(PageHeadingLevel);
  const secondary = scope.embedded || level === 2;
  const Root = scope.landmark || secondary ? "div" : "main";
  const [headSlot, setHeadSlot] = useState<HTMLElement | null>(null);
  return (
    <Root className={s.consoleFrame} data-floorplan="canvas">
      <PageHeadingLevel value={secondary ? 2 : 1}>
        <PageHead
          band
          title={t("structure.title")}
          titleId="structure-title"
          filters={tabs}
          tools={current === ORG_TABS[0] ? <div ref={setHeadSlot} className={s.headSlot} /> : undefined}
        />
      </PageHeadingLevel>
      <PageScope value={{ landmark: true, embedded: true }}>
        <PageHeadingLevel value={2}>
          <OrgHeadSlotContext.Provider value={headSlot}>
            <OrgTabsContent current={current} />
          </OrgHeadSlotContext.Provider>
        </PageHeadingLevel>
      </PageScope>
    </Root>
  );
}

/** One stable page head; each slice keeps its own toolbar and read states. */
export function OrgTabs() {
  const items = ORG_TABS.map(id => ({ id, label: t(`structure.tab.${id}`) }));
  const { selected } = useTabSearch(items);
  const current = items.find(i => i.id === selected)?.id ?? ORG_TABS[0];
  const { as_of, known_at } = route.useSearch();
  const navigate = route.useNavigate();
  const router = useRouter();
  const search = (id: string) => ({ as_of, known_at, tab: orgTab(id) });
  const tabs = <PageTabs label={t("structure.tabs")} items={items} selected={selected}
    href={id => router.buildLocation({ to: "/org", search: search(id) }).href}
    onSelect={id => void navigate({ search: search(id), replace: true, resetScroll: false })}>
    {() => null}
  </PageTabs>;
  return (
    <ExperienceSwitch baseline={() => <OrgTabsBaseline tabs={tabs} current={current} />}>
      {() => <OrgTabsConsole tabs={tabs} current={current} />}
    </ExperienceSwitch>
  );
}
