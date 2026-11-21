// SPDX-License-Identifier: LicenseRef-Proprietary
import { lazy, Suspense, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { chunk } from "../../../lib/chunk-guard";
import { QueryState } from "../../../lib/react/query-state";
import { AccessGate } from "../../../reference/authz/ui/access-gate";
import { Button, Check } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { ExperienceSwitch } from "../../../ui/patterns/pattern-shell";
import { ReadSkeleton } from "../../../ui/skeleton/skeleton";
import { Table } from "../../../ui/table";
import { entitiesRef as entitiesQuery, kindsRef } from "../../../reference/entity/api";
import { InsuranceSummary } from "../../../reference/entity/ui/insurance-summary";
import { kindName } from "../../../reference/entity/present";
import type { EditRow } from "../domain/bulk-edit";
import { BulkEditSheet } from "./bulk-edit-sheet";
import { BulkHead } from "./bulk-head";
import s from "./bulk.module.css";
import { entityName } from "../../../reference/entity/domain/names";

const BulkEditConsole = lazy(() => chunk(import("./bulk-edit-console")).then((m) => ({ default: m.BulkEditConsole })));

/** Choose open workplaces; the existing sheet owns the preview and commit. */
export function BulkEditPage() {
  return (
    <AccessGate domain="org" level="edit">
      <BulkEditWorkspace />
    </AccessGate>
  );
}

function BulkEditWorkspace() {
  const q = useQuery(entitiesQuery);
  const kinds = useQuery({ ...kindsRef, retry: false }).data?.items;
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  const all: (EditRow & { entityId: string; kindCode?: string | null })[] = (q.data?.items ?? []).flatMap((e) =>
    e.workplaces.filter((w) => !w.closed_on).map((w) => ({ id: w.id, name: w.current?.name ?? "", entity: entityName(e), entityId: e.id, insurance: w.insurance, kindCode: w.kind_code })),
  );
  const rows = all.filter((r) => chosen.has(r.id));
  const toggleLabel = t("uiLongTable.selection.toggleAll", { count: all.length, unit: "item" });
  const toggle = (id: string, on: boolean) => setChosen((x) => (on ? new Set([...x, id]) : new Set([...x].filter((y) => y !== id))));
  const first = q.data?.items[0];
  const emptyView = (
    <EmptyState
      title={t(first ? "orgBulk.edit.none" : "orgBulk.edit.noEntity")}
      reason={null}
      actions={first
        ? <Link to="/org" search={{ sel: first.id, act: "wp-create" }} className={buttonClass("primary")}>{t("entityRecord.workplaces.add")}</Link>
        : <Link to="/org/entities/new" className={buttonClass("primary")}>{t("entity.list.register")}</Link>}
    />
  );
  const renderTable = (compact: boolean) => (
    <Table
      label={t("orgBulk.edit.pick")}
      rows={all}
      rowId={r => r.id}
      mobileLayout={compact ? "compact" : "cards"}
      columns={[
        { header: <Check checked={rows.length === all.length} onChange={on => setChosen(new Set(on ? all.map(r => r.id) : []))} aria-label={toggleLabel}>{toggleLabel}</Check>,
          cell: r => <Check checked={chosen.has(r.id)} onChange={on => toggle(r.id, on)} aria-label={t("orgBulk.import.sitePath", { entity: r.entity, name: r.name })} />, fit: true, card: "action" },
        { header: t("orgBulk.edit.col.site"), cell: r => <strong>{r.name}</strong>, card: compact ? "fact" : "title" },
        { header: t("orgBulk.import.role.entity"), cell: r => compact && r.kindCode && kinds ? `${r.entity} · ${kindName(kinds, r.kindCode)}` : r.entity, card: compact ? "title" : "fact" },
        { header: t("orgBulk.site.insurance"), cell: r => <InsuranceSummary insurance={r.insurance} />, card: "status" },
        { header: t("workplace.create.kind"), cell: r => r.kindCode ? kinds ? kindName(kinds, r.kindCode) : "—" : t("workplace.kind.unset"), card: compact ? "omit" : "fact" },
      ]}
    />
  );
  const actionButtons = rows.length
    ? <Button variant="primary" onClick={() => setOpen(true)}>{t("orgBulk.edit.open", { count: rows.length })}</Button>
    : <DisabledReason reason={t("orgBulk.edit.selectFirst")} control={p => <Button variant="primary" {...p}>{t("orgBulk.edit.open", { count: 0 })}</Button>} />;
  const sheetOverlay = open ? <BulkEditSheet rows={rows} entities={new Set(rows.map((r) => r.entityId)).size} onClose={() => setOpen(false)} /> : null;

  return (
    <ExperienceSwitch
      baseline={() => (
        <div className={s.frame}>
          <BulkHead title={t("orgBulk.edit.pageTitle")} />
          <QueryState q={q} layout="list" empty={() => all.length ? null : <div className={s.body}>{emptyView}</div>}>
            {() => (
              <>
                <div className={s.body}>
                  <div className={s.workplaces}>
                    <Card title={t("orgBulk.edit.count", { count: all.length })} flush>
                      {renderTable(false)}
                    </Card>
                  </div>
                </div>
                <ActionBar sticky actions={actionButtons} />
                {sheetOverlay}
              </>
            )}
          </QueryState>
        </div>
      )}
    >
      {() => (
        <Suspense fallback={<ReadSkeleton layout="form" />}>
          <BulkEditConsole
            q={q}
            hasWorkplaces={all.length > 0}
            countTitle={all.length ? t("orgBulk.edit.count", { count: all.length }) : undefined}
            content={all.length > 0 ? <div className={s.workplaces}>{renderTable(true)}</div> : emptyView}
            actions={actionButtons}
            onSubmit={() => { if (rows.length) setOpen(true); }}
            overlays={sheetOverlay}
          />
        </Suspense>
      )}
    </ExperienceSwitch>
  );
}
