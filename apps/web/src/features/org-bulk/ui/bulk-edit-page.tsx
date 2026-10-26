// SPDX-License-Identifier: LicenseRef-Proprietary
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Check } from "../../../ui/button/button";
import { buttonClass } from "../../../ui/button/button-class";
import { Card } from "../../../ui/card/card";
import { ActionBar } from "../../../ui/action-bar/action-bar";
import { DisabledReason } from "../../../ui/disabled-reason/disabled-reason";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { entitiesRef as entitiesQuery, kindsRef } from "../../../reference/entity/api";
import { InsuranceSummary } from "../../../reference/entity/ui/insurance-summary";
import { kindName } from "../../../reference/entity/present";
import type { EditRow } from "../domain/bulk-edit";
import { BulkEditSheet } from "./bulk-edit-sheet";
import { BulkHead } from "./bulk-head";
import s from "./bulk.module.css";
import { entityName } from "../../../reference/entity/domain/names";

/** Choose open workplaces; the existing sheet owns the preview and commit. */
export function BulkEditPage() {
  const q = useQuery(entitiesQuery);
  const kinds = useQuery({ ...kindsRef, retry: false }).data?.items;
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  return (
    <div className={s.frame}>
      <BulkHead title={t("orgBulk.edit.pageTitle")} />
      <QueryState q={q} layout="list" empty={(d) => {
        if (d.items.some(e => e.workplaces.some(w => !w.closed_on))) return null;
        const first = d.items[0];
        return <div className={s.body}><EmptyState
          title={t(first ? "orgBulk.edit.none" : "orgBulk.edit.noEntity")}
          reason={null}
          actions={first
            ? <Link to="/org" search={{ sel: first.id, act: "wp-create" }} className={buttonClass("primary")}>{t("entityRecord.workplaces.add")}</Link>
            : <Link to="/org/entities/new" className={buttonClass("primary")}>{t("entity.list.register")}</Link>}
        /></div>;
      }}>
        {(d) => {
          const all: (EditRow & { entityId: string; kindCode?: string | null })[] = d.items.flatMap((e) =>
            e.workplaces.filter((w) => !w.closed_on).map((w) => ({ id: w.id, name: w.current?.name ?? "", entity: entityName(e), entityId: e.id, insurance: w.insurance, kindCode: w.kind_code })),
          );
          const rows = all.filter((r) => chosen.has(r.id));
          const toggle = (id: string, on: boolean) => setChosen((x) => (on ? new Set([...x, id]) : new Set([...x].filter((y) => y !== id))));
          return (
            <>
              <div className={s.body}>
                <div className={s.workplaces}>
                <Card title={t("orgBulk.edit.count", { count: all.length })} flush>
                  <Table
                    label={t("orgBulk.edit.pick")}
                    rows={all}
                    rowId={r => r.id}
                    columns={[
                      { header: <Check checked={rows.length === all.length} onChange={on => setChosen(new Set(on ? all.map(r => r.id) : []))} aria-label={t("uiLongTable.selection.selectAll", { total: all.length, unit: "item" })} />,
                        cell: r => <Check checked={chosen.has(r.id)} onChange={on => toggle(r.id, on)} aria-label={t("orgBulk.import.sitePath", { entity: r.entity, name: r.name })} />, fit: true },
                      { header: t("orgBulk.edit.col.site"), cell: r => <strong>{r.name}</strong> },
                      { header: t("orgBulk.import.role.entity"), cell: r => r.entity },
                      { header: t("orgBulk.site.insurance"), cell: r => <InsuranceSummary insurance={r.insurance} /> },
                      { header: t("workplace.create.kind"), cell: r => r.kindCode ? kinds ? kindName(kinds, r.kindCode) : "—" : t("workplace.kind.unset") },
                    ]}
                  />
                </Card>
                </div>
              </div>
              <ActionBar sticky actions={rows.length
                ? <Button variant="primary" onClick={() => setOpen(true)}>{t("orgBulk.edit.open", { count: rows.length })}</Button>
                : <DisabledReason reason={t("orgBulk.edit.selectFirst")} control={p => <Button variant="primary" {...p}>{t("orgBulk.edit.open", { count: 0 })}</Button>} />}
              />
              {open && <BulkEditSheet rows={rows} entities={new Set(rows.map((r) => r.entityId)).size} onClose={() => setOpen(false)} />}
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
