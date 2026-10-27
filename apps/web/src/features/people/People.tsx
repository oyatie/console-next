import { lazy, Suspense, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../lib/react/query-state";
import { ToggleButton } from "../../ui/button/button";
import { ApiError, authzQuery, granted, myAccessQuery } from "../../reference/authz/api";
import { Accounts } from "./Accounts";
import { PeopleHead, type PeopleView } from "./ui/people-head";
import { RosterPage } from "./ui/roster-page";
import { UnplacedRoster } from "./ui/unplaced-roster";
import { PEOPLE_TABS, type PeopleTab } from "./domain/people-tabs";
import type { ExitFilter } from "./api";
import { useTabSearch } from "../../lib/react/use-tab-search";
import { Page } from "../../ui/page/page";
import { PageTabs } from "../../ui/tabs/page-tabs";
import { ReadSkeleton } from "../../ui/skeleton/skeleton";
import { AccessGate } from "../../reference/authz/ui/access-gate";
import { accessRefusal } from "../../reference/authz/domain/access";

const AppointmentsContent = lazy(() => import("./ui/appointments-content").then(module => ({ default: module.AppointmentsContent })));
const ExitCaseListContent = lazy(() => import("./ui/exit-list").then(module => ({ default: module.ExitCaseListContent })));

/**
 * The People page's URL: the view, the selected row, and the roster's filters (`status`: a status or "all",
 * nothing = current staff; `review`: comma-joined attention chips, see domain/roster.ts). The search term (a
 * person's name or number) stays out of the URL and so out of history. `bulk=paste` opens the bulk sheet from a paste.
 */
export type PeopleSearch = { tab?: PeopleTab; exitStatus?: ExitFilter; placement?: "unplaced"; sel?: string; view?: PeopleView; unit?: string; status?: string; sort?: string; review?: string; bulk?: "paste"; export?: "register" };

const route = getRouteApi("/app/people");

export function People() {
  const tabs = useTabSearch(PEOPLE_TABS);
  const { exitStatus } = route.useSearch();
  const { peopleAccess } = route.useRouteContext();
  const navigate = route.useNavigate();
  return <Page floorplan="list" head={{ title: t("roster.head.title"), titleId: "people-title" }}>
    <PageTabs {...tabs} label={t("roster.head.title")} items={PEOPLE_TABS.map(({ id }) => ({ id, label: t(`roster.page.${id}`) }))}>
      {selected => <Suspense fallback={<ReadSkeleton layout="list" />}>
        {selected === "roster" && <AccessGate {...peopleAccess.roster} layout="list"><PeopleDirectory /></AccessGate>}
        {selected === "appointments" && <AppointmentsContent />}
        {selected === "exits" && <AccessGate {...peopleAccess.exits} layout="list"><ExitCaseListContent status={exitStatus} onStatus={status => void navigate({ search: previous => ({ ...previous, exitStatus: status }), replace: true })} /></AccessGate>}
      </Suspense>}
    </PageTabs>
  </Page>;
}

/** Employees (the roster) or accounts, with their existing server capability decisions. */
export function PeopleDirectory() {
  const { view: asked, sel } = route.useSearch();
  const navigate = route.useNavigate();
  const authz = useQuery(authzQuery);
  const can = granted(authz.data?.capabilities);
  // BW-22: a full directory read on any branches lists that reader's branches; a user manager without one has the
  // accounts view only.
  const directory = authz.isPending || can("employee_directory_read", "branch");
  const scoped = !can("employee_directory_read", "all");
  const view = directory ? (asked ?? "employees") : "accounts";
  const onView = (v: PeopleView) => void navigate({ search: (prev) => ({ ...prev, view: v === "accounts" ? v : undefined, sel: undefined }), replace: true });
  const head = (actions?: ReactNode, available = true) => <PeopleHead view={view} directory={directory && available} onView={onView}>{actions}</PeopleHead>;
  // Not before the permissions land (a fresh load): the roster's select column and its commands would appear
  // after its rows and push every column aside.
  const denied = authz.isSuccess && !directory && !can("user_manage");
  const state = denied ? { ...authz, error: new ApiError(403, "access_denied", "", [], undefined, false) } : authz;
  return <QueryState q={state} layout="list">{() => {
  const switcher = directory && (
    <div role="group" aria-label={t("people.tabs")} className="row">
      {(["employees", "accounts"] as const).map((v) => (
        <ToggleButton key={v} pressed={view === v} onClick={() => onView(v)}>{t(v === "employees" ? "people.tab.employees" : "people.tab.accounts")}</ToggleButton>
      ))}
    </div>
  );
  if (view === "employees") return <Directory manage={can("employee_directory_manage", "all")} scoped={scoped} switcher={switcher} />;
  return <div className="page"><Accounts head={(available, search) => head(search, available)} sel={sel} /></div>;
  }}</QueryState>;
}

function Directory(props: Parameters<typeof RosterPage>[0]) {
  const { peopleAccess } = route.useRouteContext();
  const access = useQuery(myAccessQuery);
  const unplaced = route.useSearch().placement === "unplaced";
  const refused = access.data && accessRefusal(access.data, peopleAccess.unplaced) !== null;
  return unplaced && !refused ? <UnplacedRoster {...props} /> : <RosterPage {...props} notice={unplaced ? t("roster.unplaced.unavailable") : undefined} />;
}
