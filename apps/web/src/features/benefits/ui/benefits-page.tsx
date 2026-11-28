// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { readsAreStale, useCommand } from "../../../lib/react/command";
import { CommandError } from "../../../lib/react/command-error";
import { QueryState } from "../../../lib/react/query-state";
import { useIsDesktop } from "../../../lib/react/use-desktop";
import { authzQuery } from "../../../reference/authz/api";
import { Button } from "../../../ui/button/button-base";
import { Dialog } from "../../../ui/dialog";
import { EmptyState } from "../../../ui/empty-state";
import { BenefitDetail } from "./benefit-detail";
import { LongTable } from "../../../ui/long-table/long-table";
import { SettingsPattern } from "../../../ui/patterns/settings";
import { catalogReads, itemQuery, itemsQuery, writeBenefit, type Item } from "../api";
import { ItemFields, type Scope } from "./item-fields";
import { RuleFields } from "./rule-fields";
import s from "./benefits.module.css";

type Editor = { kind: "create" } | { kind: "edit" | "conditions" | "tiers"; item: Item };
const titles = { create: "benefits.create", edit: "benefits.edit", tiers: "benefits.editTiers", conditions: "benefits.editConditions" } as const;
const limit = 25;
function mayEdit(scope: Scope, item: Item) {
  return item.scope.branch_id ? scope.branch_scope.kind === "all" || scope.branch_scope.branches?.includes(item.scope.branch_id) : scope.org_wide;
}
export function BenefitsPage() {
  const [offset, setOffset] = useState(0);
  const [selected, select] = useState<string | null>();
  const [editor, open] = useState<Editor>();
  const [saved, savedItem] = useState<string>();
  const desktop = useIsDesktop();
  const list = useQuery(itemsQuery(offset, limit));
  const access = useQuery(authzQuery);
  const manage = access.isSuccess ? access.data.capabilities.find(cap => cap.feature === "served_benefit_catalog_manage" && cap.permission !== "request_only") : undefined;
  const page = list.isSuccess ? list.data : undefined;
  const rows = page?.items ?? [];
  const shown = selected === undefined && desktop ? rows[0]?.id : selected;
  const detail = useQuery({ ...itemQuery(shown ?? ""), enabled: !!shown && !!page });
  const item = detail.isSuccess ? detail.data : undefined;
  const command = useCommand({ run: writeBenefit, invalidates: [...catalogReads], settle: true, onSuccess: value => {
    open(undefined); select(value.id); savedItem(value.name);
  }, announce: value => t("benefits.saved", { name: value.name }) });
  const edit = (next: Editor) => { command.reset(); savedItem(undefined); open(next); };
  const turn = (next: number) => { select(undefined); setOffset(next); };
  return <SettingsPattern q={list.error ? { ...list, data: undefined } : list} head={{
    title: t("benefits.title"), ...(manage && { primary: { id: "create-benefit", label: t("benefits.create"), onAction: () => edit({ kind: "create" }) } }),
  }} panel={<div className={s.list}>
    {saved && <p role="status">{t("benefits.saved", { name: saved })}</p>}
    {rows.length ? <LongTable label={t("benefits.title")} rows={rows} rowId={row => row.id} activeRowId={shown ?? undefined}
      onRowAction={select} total={rows.length} hasMore={false} onLoadMore={() => {}} density="compact" mobileLayout="compact" empty={t("benefits.empty")}
      columns={[
        { id: "name", header: t("benefits.name"), rowHeader: true, card: "title", width: "2fr", cell: row => row.name },
        { id: "coverage", header: t("benefits.coverage"), card: "fact", width: "1fr", cell: row => row.coverage_label },
        { id: "cost", header: t("benefits.cost"), card: "fact", width: "1fr", cell: row => row.cost_label },
      ]} /> : <EmptyState title={t("benefits.empty")} reason={t("benefits.emptyReason")} />}
    {page && (offset > 0 || page.total > limit) && <div className={s.actions}>
      <Button disabled={!offset} onClick={() => turn(Math.max(0, offset - limit))}>{t("audit.log.pagination.prev")}</Button>
      <Button disabled={offset + limit >= page.total} onClick={() => turn(offset + limit)}>{t("audit.log.pagination.next")}</Button>
    </div>}
  </div>} record={shown ? { id: shown, label: t("benefits.item"), title: item?.name ?? t("benefits.item"), onClose: () => select(null),
    children: <QueryState q={detail.error ? { ...detail, data: undefined } : detail}>{record => <div className={s.record}>
      <BenefitDetail item={record} />
      {manage && mayEdit(manage, record) && <div className={s.actions}>{(["edit", "tiers", "conditions"] as const).map(kind =>
        <Button key={kind} onClick={() => edit({ kind, item: record })}>{t(titles[kind])}</Button>)}</div>}
    </div>}</QueryState> } : undefined}
    overlays={editor && manage && (editor.kind === "create" || mayEdit(manage, editor.item)) && <Dialog open title={t(titles[editor.kind])}
      dismissable={!command.isPending} onClose={() => open(undefined)}>
      {editor.kind === "create" || editor.kind === "edit" ? <ItemFields item={editor.kind === "edit" ? editor.item : undefined}
        scope={manage} submit={command.mutate} busy={command.isPending} /> :
        <RuleFields kind={editor.kind} item={editor.item} submit={command.mutate} busy={command.isPending} />}
      {readsAreStale(command.error) ? <div role="alert">
        <p>{t("benefits.conflict")}</p><Button onClick={() => { open(undefined); void detail.refetch(); }}>{t("benefits.reviewCurrent")}</Button>
      </div> : command.error && <CommandError error={command.error} />}
    </Dialog>} />;
}
