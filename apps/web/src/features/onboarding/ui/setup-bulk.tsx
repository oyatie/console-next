import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { todayKst } from "../../../lib/pure/today";
import { saveFile } from "../../../lib/download";
import { Button } from "../../../ui/button/button";
import { SectionHead } from "../../../ui/card/section-head";
import { entitiesRef, orgStructureRef, kindsRef } from "../../../reference/entity/api";
import { SHEET_COLUMNS, setupSheet } from "../domain/sheet";
import { QueryState } from "../../../lib/react/query-state";
import { readGroup } from "../../../lib/react/query-view";

/** The org sheet columns, including an empty header before the first entity. */
export function SetupBulk({ allowed }: { allowed: boolean }) {
  const q = useQuery({ ...orgStructureRef, enabled: allowed });
  const entities = useQuery({ ...entitiesRef, enabled: allowed });
  const kinds = useQuery({ ...kindsRef, enabled: allowed });
  const download = () => {
    const csv = setupSheet(q.data!, entities.data!.items, SHEET_COLUMNS.map((key) => t(`structureChart.sheet.${key}`)), (node) => {
      const key = node.kind === "LEGAL_ENTITY" ? "entity" : node.kind === "DEPARTMENT" ? "dept" : "site";
      const kind = kinds.data?.items.find((k) => k.code === node.workplace_kind)?.label;
      const name = t(`structure.level.${key}`);
      return kind && kind !== name ? `${name} · ${kind}` : name;
    });
    saveFile(new Blob([csv], { type: "text/csv;charset=utf-8" }), t("structureChart.sheet.file", { date: todayKst() }));
  };
  return <section aria-labelledby="setup-bulk">
    <SectionHead level={2} id="setup-bulk">{t("setup.bulk.title")}</SectionHead>
    {allowed && <div className="row wrap">
      <Button disabled={!q.data || !entities.data || !kinds.data || q.isError || entities.isError || kinds.isError} onClick={download}>{t("setup.bulk.download")}</Button>
    </div>}
    {allowed && <QueryState q={readGroup([q, entities, kinds])}>{() => null}</QueryState>}
    {!allowed && <p>{t("setup.permissionNeeded", { permission: t("setup.permission.org::edit") })}</p>}
  </section>;
}
