import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { QueryState } from "../../../lib/react/query-state";
import { Button, Check } from "../../../ui/button/button";
import { entitiesRef as entitiesQuery } from "../../../reference/entity/api";
import type { EditRow } from "../domain/bulk-edit";
import { BulkEditSheet } from "./bulk-edit-sheet";
import { BulkHead } from "./bulk-head";
import s from "./bulk.module.css";
import { entityName } from "../../../reference/entity/domain/names";

/**
 * The workplaces to edit together, chosen by hand, until the org chart's multi-select hands its selection to
 * BulkEditSheet directly (S2 selection bar).
 */
export function BulkEditPage() {
  const q = useQuery(entitiesQuery);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  return (
    <div className={s.frame}>
      <BulkHead title={t("orgBulk.edit.pageTitle")} />
      <QueryState q={q}>
        {(d) => {
          const all: (EditRow & { entityId: string })[] = d.items.flatMap((e) =>
            e.workplaces.filter((w) => !w.closed_on).map((w) => ({ id: w.id, name: w.current?.name ?? "", entity: entityName(e), entityId: e.id, insurance: w.insurance })),
          );
          const rows = all.filter((r) => chosen.has(r.id));
          const toggle = (id: string, on: boolean) => setChosen((x) => (on ? new Set([...x, id]) : new Set([...x].filter((y) => y !== id))));
          return (
            <div className={s.body}>
              {/* The action sits above the list, so a list that grows on refetch never moves it. */}
              <div>
                <Button variant="primary" aria-disabled={rows.length === 0 || undefined} onClick={() => rows.length && setOpen(true)}>{t("orgBulk.edit.open", { count: rows.length })}</Button>
              </div>
              <fieldset className={s.col}>
                <legend className={s.colHead}>{t("orgBulk.edit.pick")}</legend>
                {all.length === 0 && <p className={s.note}>{t("orgBulk.edit.none")}</p>}
                {all.map((r) => (
                  <Check key={r.id} checked={chosen.has(r.id)} onChange={(on) => toggle(r.id, on)}>{t("orgBulk.import.sitePath", { entity: r.entity, name: r.name })}</Check>
                ))}
              </fieldset>
              {open && <BulkEditSheet rows={rows} entities={new Set(rows.map((r) => r.entityId)).size} onClose={() => setOpen(false)} />}
            </div>
          );
        }}
      </QueryState>
    </div>
  );
}
