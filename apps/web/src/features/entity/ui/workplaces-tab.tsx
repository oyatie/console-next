import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { labeled, RECORD_STATUS, TAX_TYPE, label, VERIFICATION } from "../../../lib/labels";
import { Muted } from "../../../ui/muted/muted";
import { Chip } from "../../../ui/chip";
import { EmptyState } from "../../../ui/empty-state";
import { Table } from "../../../ui/table";
import { registrationOf, registrationTodo, workplaceName } from "../domain/view";
import { entityName } from "../../../reference/entity/domain/names";
import { WorkplacePanel } from "./workplace-panel";

/**
 * The entity's workplaces, each with the certificate it is registered under (its own, or the unit-taxation
 * one with a serial), the NTS status and its people. Selecting one opens its detail beside the list.
 */
export function WorkplacesTab({ e, selected }: { e: LegalEntity; selected?: string }) {
  const [sel, setSel] = useState(selected);
  const [linked, setLinked] = useState(selected);
  if (linked !== selected) { setLinked(selected); setSel(selected); }
  // Nothing chosen yet: the first workplace, also when the list arrives after this tab opened (a refetch after a create).
  const current = e.workplaces.find((w) => w.id === sel) ?? e.workplaces[0];
  const reg = (id?: string | null) => registrationOf(e, id);
  const add = !e.read_only && (
    <Link to="/org/entities/$id/workplaces/new" params={{ id: e.id }} className="btn btn--primary">
      <Plus size={16} aria-hidden /> {t("workplace.add")}
    </Link>
  );
  if (e.workplaces.length === 0)
    return <section className="card"><EmptyState title={t("workplace.empty.title", { entity: entityName(e) })} reason={t("workplace.empty.reason")} actions={add} /></section>;
  return (
    <div className="split" data-open={Boolean(current)}>
      <section className="card">
        <div className="toolbar">
          <h2 className="toolbar__title">{t("workplace.list.title")}</h2>
          {add}
        </div>
        <Table
          label={t("workplace.list.title")}
          rows={e.workplaces}
          rowId={(w) => w.id}
          selected={current?.id}
          onSelect={setSel}
          columns={[
            { header: t("workplace.col.name"), cell: (w) => <span className="row">{workplaceName(w)}{w.is_primary && <Chip tone="info">{t("workplace.primary")}</Chip>}{w.is_head_office && <Chip>{t("workplace.headOffice")}</Chip>}{w.needs_confirmation && <Chip tone="warn">{t("workplace.incomplete")}</Chip>}</span> },
            {
              header: t("workplace.col.brn"),
              fit: true,
              cell: (w) => {
                const r = reg(w.registration_id);
                return r ? <span className="code">{r.brn?.display ?? t("workplace.brnPending")}{w.sub_serial && ` · ${w.sub_serial}`}</span> : registrationTodo(w) ? <Muted>{t("workplace.filing.entityBasis")}{reg(w.filing_registration_id)?.brn?.display && ` · ${reg(w.filing_registration_id)?.brn?.display}`}</Muted> : <Chip tone="neutral">{w.not_registered_reason?.label ?? "—"}</Chip>;
              },
            },
            { header: t("workplace.col.taxType"), cell: (w) => { const tax = reg(w.registration_id)?.current?.tax_type; return tax ? label(TAX_TYPE, tax) : "—"; }, fit: true, wide: true },
            { header: t("workplace.col.verified"), cell: (w) => { const r = reg(w.registration_id); if (!r) return "—"; const v = labeled(VERIFICATION, r.verification_tier); return <Chip tone={v.tone}>{v.label}</Chip>; }, fit: true },
            { header: t("workplace.col.issued"), cell: (w) => { const on = reg(w.registration_id)?.current?.cert_issued_on; return <span className="num">{on ? fmtDate(on) : "—"}</span>; }, fit: true, wide: true },
            { header: t("workplace.col.status"), cell: (w) => { const st = labeled(RECORD_STATUS, w.current?.status ?? "CONTINUING"); return <Chip tone={st.tone}>{st.label}</Chip>; }, fit: true },
            { header: t("workplace.col.people"), cell: (w) => <span className="num">{t("entity.count.people", { count: w.headcount })}</span>, fit: true },
          ]}
        />
      </section>
      {current && <WorkplacePanel e={e} w={current} />}
    </div>
  );
}
