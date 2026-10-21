import { useState, type FormEvent, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Search } from "lucide-react";
import { t } from "@console/i18n";
import { QueryState } from "../../lib/react/query-state";
import { ToggleButton } from "../../ui/button/button";
import { authzQuery, granted } from "../../reference/authz/api";
import { Accounts } from "./Accounts";
import { PeopleHead, type PeopleView } from "./ui/people-head";
import { RosterPage } from "./ui/roster-page";

/**
 * The People page's URL: the view, the selected row, and the roster's filters (`status`: a status or "all",
 * nothing = current staff; `review`: comma-joined attention chips, see domain/roster.ts). The search term (a
 * person's name or number) stays out of the URL and so out of history. `bulk=paste` opens the bulk sheet from a paste.
 */
export type PeopleSearch = { sel?: string; view?: PeopleView; unit?: string; status?: string; sort?: string; review?: string; bulk?: "paste"; export?: "register" };

const route = getRouteApi("/app/people");

/** Employees (the roster, ui/roster-page.tsx) or accounts (ui/accounts-list.tsx, through Accounts.tsx). */
export function People() {
  const { view: asked, sel } = route.useSearch();
  const navigate = route.useNavigate();
  const authz = useQuery(authzQuery);
  const can = granted(authz.data?.capabilities, authz.isError);
  // BW-22: a full directory read on any branches lists that reader's branches; a user manager without one has the
  // accounts view only.
  const directory = authz.isPending || can("employee_directory_read", "branch");
  const scoped = !can("employee_directory_read", "all");
  const view = directory ? (asked ?? "employees") : "accounts";
  const onView = (v: PeopleView) => void navigate({ search: (prev) => ({ ...prev, view: v === "accounts" ? v : undefined, sel: undefined }), replace: true });
  const head = (actions?: ReactNode) => <PeopleHead view={view} directory={directory} onView={onView}>{actions}</PeopleHead>;
  // Not before the permissions land (a fresh load): the roster's select column and its commands would appear
  // after its rows and push every column aside.
  if (authz.isPending) return <div className="page"><QueryState q={authz}>{() => null}</QueryState></div>;
  const switcher = directory && (
    <div role="group" aria-label={t("people.tabs")} className="row">
      {(["employees", "accounts"] as const).map((v) => (
        <ToggleButton key={v} pressed={view === v} onClick={() => onView(v)}>{t(v === "employees" ? "people.tab.employees" : "people.tab.accounts")}</ToggleButton>
      ))}
    </div>
  );
  if (view === "employees") return <RosterPage key="employees" manage={can("employee_directory_manage", "all")} scoped={scoped} switcher={switcher} />;
  return <AccountsView head={head} sel={sel} onSelect={(id) => void navigate({ search: (prev) => ({ ...prev, sel: id }), replace: true })} />;
}

function AccountsView({ head, sel, onSelect }: { head: (actions?: ReactNode) => ReactNode; sel?: string; onSelect: (id?: string) => void }) {
  const [draft, setDraft] = useState("");
  const [q, setQ] = useState("");
  const search = (e: FormEvent) => {
    e.preventDefault();
    setQ(draft.trim());
    onSelect(undefined);
  };
  return (
    <div className="page">
      {head(
        <form role="search" onSubmit={search} className="search">
          <input className="field__input" aria-label={t("accounts.search.label")} placeholder={t("accounts.search.placeholder")} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <button className="btn" type="submit"><Search size={16} aria-hidden /> {t("people.search.accounts")}</button>
        </form>,
      )}
      {/* Keyed by the search: a new query starts again from the first page. */}
      <Accounts key={q} q={q} sel={sel} onSelect={onSelect} />
    </div>
  );
}
