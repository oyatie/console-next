import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { UserPlus } from "lucide-react";
import type { components } from "@console/api/schema";
import { t } from "@console/i18n";
import { fmtDateTime } from "@console/i18n/format";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { LongTable, type LongColumn } from "../../../ui/long-table/long-table";
import { focusSoon } from "../../../lib/react/announce";
import { get } from "../../../lib/query";
import { ACCOUNT_STATUS, labeled } from "../../../lib/labels";
import { useCan } from "../../../reference/authz/ui/use-can";
import { sheetOf, type AccountsSearch } from "../domain/accounts";
import { AccountPanel } from "./account-panel";
import { InviteSheet } from "./account-invite-sheet";
import { IssuedCode } from "./account-issued-code";
import type { Issued } from "./use-issue-code";
import { Muted } from "../../../ui/muted/muted";

type Person = components["schemas"]["DirectoryPerson"];
const route = getRouteApi("/app/people");
const PAGE = 100;
const PATH = "/api/v1/directory/people";

/**
 * Accounts: a server-searched list (deactivated accounts behind a toggle), loaded a page at a time; the selected
 * account's panel; and the invite sheet, opened by `act` so Back closes it. `q` is the page's search box (a name or
 * employee number, kept out of the URL). There are no preset roles (governance-01): an account carries no access, and
 * the panel links to Access for what it may do.
 */
export function Accounts({ q, sel }: { q: string; sel?: string; onSelect?: (id?: string) => void }) {
  const s = route.useSearch() as AccountsSearch;
  const navigate = route.useNavigate();
  const set = (patch: AccountsSearch & { sel?: string }, push = false) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: !push });
  const closeSheet = (then: { sel?: string } = {}) => set({ act: undefined, employee: undefined, ...then });
  const admin = useCan()("user_manage");
  const [receipt, setReceipt] = useState<{ id: string; message: string }>();
  const [issued, setIssued] = useState<Issued | null>(null);
  const base = { search: q || undefined, include_inactive: s.inactive ?? false };
  const list = useInfiniteQuery({
    ...get(PATH, { params: { query: { ...base, limit: PAGE } } }),
    queryFn: ({ pageParam }) => get(PATH, { params: { query: { ...base, limit: PAGE, offset: pageParam } } }).queryFn(),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const n = pages.reduce((sum, p) => sum + p.items.length, 0);
      return last.items.length > 0 && n < last.total ? n : undefined;
    },
    // Polling would re-read every loaded page; focus refetch keeps the list current.
    refetchInterval: false,
  });
  const seen = new Set<string>();
  const rows = (list.data?.pages.flatMap((p) => p.items) ?? []).filter((p) => !seen.has(p.id) && seen.add(p.id));
  const total = list.data?.pages[0]?.total;
  const sheet = sheetOf(s.act);
  const recorded = (id: string) => (message: string) => {
    setReceipt({ id, message });
    focusSoon("acct-title");
  };
  const filtered = Boolean(s.inactive);

  return (
    <div className="split" data-open={Boolean(sel)}>
      <section className="card" aria-labelledby="accounts-title">
        <div className="toolbar">
          <h2 id="accounts-title" className="toolbar__title" tabIndex={-1}>{t("accounts.title")}</h2>
          {admin && <Button variant="primary" onClick={() => set({ act: "invite" }, true)}><UserPlus size={16} aria-hidden /> {t("accounts.invite")}</Button>}
        </div>
        <div className="toolbar">
          <Button variant={s.inactive ? "secondary" : "ghost"} aria-pressed={s.inactive ?? false} onClick={() => set({ inactive: s.inactive ? undefined : true })}>{t("accounts.includeInactive")}</Button>
        </div>
        <LongTable
          label={t("accounts.table")}
          density="compact"
          caption={total === undefined ? undefined : t("accounts.count", { count: total })}
          columns={columns(sel)}
          rows={rows}
          rowId={(p) => p.id}
          total={total}
          hasMore={list.hasNextPage}
          loadingMore={list.isFetchingNextPage}
          onLoadMore={() => void list.fetchNextPage()}
          loading={list.isPending}
          empty={
            <EmptyState
              title={t("accounts.noMatch.title")}
              reason={q ? t("accounts.noMatch.reason", { q }) : t("accounts.noMatch.filtered")}
              actions={filtered ? <Button onClick={() => set({ inactive: undefined })}>{t("accounts.filter.reset")}</Button> : undefined}
            />
          }
          onRowAction={(id) => (setReceipt(undefined), set({ sel: id }))}
        />
      </section>
      {/* Keyed per account: switching accounts must not carry one account's choices or errors to another. */}
      {sel && (
        <AccountPanel
          key={sel}
          id={sel}
          row={rows.find((p) => p.id === sel)}
          admin={admin}
          receipt={receipt?.id === sel ? receipt.message : undefined}
          onClose={() => set({ sel: undefined })}
          onIssued={setIssued}
          onRecorded={recorded(sel)}
        />
      )}
      {admin && sheet?.kind === "invite" && (
        <InviteSheet
          employeeId={s.employee}
          onClose={() => closeSheet()}
          onIssued={(r) => (closeSheet({ sel: r.userId }), setIssued(r), setReceipt({ id: r.userId, message: t("accounts.invite.done", { name: r.name }) }))}
          onOpenAccount={(id) => closeSheet({ sel: id })}
        />
      )}
      {/* The sheet or panel that opened the code is gone, so focus goes to a stable heading after it. */}
      <IssuedCode issued={issued} onDone={() => (setIssued(null), focusSoon("acct-title", "accounts-title"))} />
    </div>
  );
}

/** Built per render: headers read the catalog, which loads after this module; `open` is the account in the panel. */
const columns = (open?: string): LongColumn<Person>[] => [
  // The open account's row is marked, so the panel beside the list says whose it is.
  {
    id: "name",
    header: t("accounts.col.name"),
    // The ops account is the one preset: named as such, never by a role title (company-17).
    cell: (p) => <>{p.id === open ? <strong aria-current="true">{p.display_name}</strong> : p.display_name}{p.is_tenant_ops && <> <Chip tone="info">{t("accounts.ops")}</Chip></>}</>,
    rowHeader: true,
    width: "2fr",
  },
  {
    id: "employee",
    header: t("accounts.col.employee"),
    cell: (p) => (p.employee_link_status === "LINKED" ? (p.employee_number ? t("accounts.employee.code", { name: p.employee_name ?? "", number: p.employee_number }) : p.employee_name) : <Muted>{t("accounts.unlinked")}</Muted>),
    width: "2fr",
  },
  {
    id: "status",
    header: t("accounts.col.status"),
    cell: (p) => {
      const st = labeled(ACCOUNT_STATUS, p.account_status);
      return <>{<Chip tone={st.tone}>{st.label}</Chip>} {!p.is_active && <Chip>{t("accounts.inactive")}</Chip>}</>;
    },
  },
  { id: "passkey", header: t("accounts.col.passkey"), cell: (p) => t(p.has_passkey ? "accounts.passkey.yes" : "accounts.passkey.no"), width: 96 },
  { id: "created", header: t("accounts.col.created"), cell: (p) => <span className="num">{fmtDateTime(p.created_at)}</span>, width: 128 },
];
