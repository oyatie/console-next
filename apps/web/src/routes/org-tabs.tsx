// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense } from "react";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../lib/chunk-guard";
import { useTabSearch } from "../lib/react/use-tab-search";
import { Page } from "../ui/page/page";
import { PageTabs } from "../ui/tabs/page-tabs";
import { ToggleButton } from "../ui/button/button";
import { ReadSkeleton } from "../ui/skeleton/skeleton";
import { AccessGate } from "../reference/authz/ui/access-gate";
import { readRequirement } from "./route-reads";
import { ORG_TABS, orgTab } from "./org-tab-search";

const Chart = lazy(() => chunk(import("./org-screen")).then(m => ({ default: m.OrgScreen })));
const Entities = lazy(() => chunk(import("../features/entity/ui/entity-routes")).then(m => ({ default: m.EntitiesScreen })));
const Changes = lazy(() => chunk(import("../features/org/OrgChange")).then(m => ({ default: m.OrgChanges })));
const History = lazy(() => chunk(import("../features/org-bulk/ui/history-page")).then(m => ({ default: m.HistoryPage })));
const route = getRouteApi("/app/org");

/** One stable page head; each slice keeps its own toolbar and read states. */
export function OrgTabs() {
  const items = ORG_TABS.map(id => ({ id, label: t(`structure.tab.${id}`) }));
  const { selected } = useTabSearch(items);
  const current = items.find(i => i.id === selected)?.id ?? ORG_TABS[0];
  const { filter, as_of, known_at } = route.useSearch();
  const navigate = route.useNavigate();
  const router = useRouter();
  const search = (id: string) => ({ as_of, known_at, tab: orgTab(id) });
  const tabs = <PageTabs label={t("structure.tabs")} items={items} selected={selected}
    href={id => router.buildLocation({ to: "/org", search: search(id) }).href}
    onSelect={id => void navigate({ search: search(id), replace: true, resetScroll: false })}>
    {() => null}
  </PageTabs>;
  return <Page floorplan="canvas" head={{ title: t("structure.title"), titleId: "structure-title", tabs }}>
    <Suspense fallback={<ReadSkeleton layout="list" />}>
      {current === ORG_TABS[1] ? <AccessGate {...readRequirement("/org/entities")} layout="list"><Entities /></AccessGate>
        : current === ORG_TABS[2] ? <AccessGate {...readRequirement("/org/changes")} layout="list"><Changes history={{
          chip: <ToggleButton pressed={filter === "history"} onClick={() => void navigate({ search: q => ({ ...q, filter: "history" }), replace: true })}>{t("orgChange.list.view.history")}</ToggleButton>,
          body: <Suspense fallback={<ReadSkeleton layout="list" />}><History /></Suspense>,
        }} /></AccessGate> : <Chart />}
    </Suspense>
  </Page>;
}
