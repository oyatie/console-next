import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LegalEntity, Workplace } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { INSURANCE_STATUS, INSURER, label, labeled } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { workplaceName } from "../domain/view";
import { RowActions } from "../../../ui/record-actions/record-actions";
import { useRecordLock } from "./use-record-lock";
import { checklistRef } from "../../../reference/entity/api";
import { WorkplaceEdit } from "./workplace-edit";
import css from "../../../reference/org/ui/structure.module.css";

/**
 * social insurance · insurance numbers, four independent numbers, one per insurer (D11): never filled from the BRN. The unit
 * line says whether this workplace reports under its own numbers or another's.
 */
function InsuranceTable({ e, w, act }: { e: LegalEntity; w: Workplace; act: ReactNode }) {
  const partOf = w.insurance.find((r) => r.unit_mode === "PART_OF");
  const main = partOf && e.workplaces.find((x) => x.id === partOf.main_workplace_id);
  return (
    <>
      <dl className={css.kv}>
        <div className={css.kvRow}>
          <dt>{t("orgStructure.ins.unit")}</dt>
          <dd>{main ? t("orgStructure.ins.partOf", { name: workplaceName(main) }) : t("orgStructure.ins.own")}</dd>
          <dd className={css.act}>{act}</dd>
        </div>
      </dl>
      {w.insurance.length > 0 ? (
        <Table
          label={t("orgStructure.wp.insurance")}
          rows={w.insurance}
          rowId={(r) => r.insurer}
          columns={[
            { header: t("orgStructure.ins.insurer"), cell: (r) => label(INSURER, r.insurer) },
            { header: t("workplace.field.status"), cell: (r) => { const st = labeled(INSURANCE_STATUS, r.status); return <Chip tone={st.tone}>{st.label}</Chip>; }, fit: true },
            { header: t("workplace.field.mgmtNo"), cell: (r) => <span className="num">{r.mgmt_no?.display ?? "—"}</span> },
            { header: t("workplace.field.establishedOn"), cell: (r) => <span className="num">{r.established_on ? fmtDate(r.established_on) : "—"}</span>, fit: true },
          ]}
        />
      ) : (
        <p className={css.note}>{t("orgStructure.ins.none")}</p>
      )}
    </>
  );
}

/**
 * A workplace's social insurance relations with their one edit (record-actions §3): the same block on the legal entity page's panel and the
 * chart's side panel, its sheet editing only the insurance relations as their own dated revision.
 */
export function WorkplaceInsurance({ e, w, onHistory }: { e: LegalEntity; w: Workplace; onHistory: () => void }) {
  const [open, setOpen] = useState(false);
  const setup = useQuery({ ...checklistRef, retry: false }).data?.phase === "SETUP";
  // A historical view (as-of) of the legal entity page draws no verbs, like the record's own fact rows.
  const asof = useRecordLock() === "asof";
  const manage = !asof && !e.read_only && !w.read_only && w.can_manage;
  const field = t("workplace.field.insurance");
  return (
    <>
      <InsuranceTable e={e} w={w} act={manage && <RowActions field={field} onEdit={() => setOpen(true)} why={w.closed_on ? t("workplace.closed.noEdit") : undefined} path={setup ? "setup" : "revision"} history={onHistory} />} />
      {open && <WorkplaceEdit e={e} w={w} field="insurance" setup={setup} onClose={() => setOpen(false)} />}
    </>
  );
}
