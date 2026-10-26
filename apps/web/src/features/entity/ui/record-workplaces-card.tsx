import { Link, useNavigate } from "@tanstack/react-router";
import { ChevronRight, Plus } from "lucide-react";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { fmtNumber } from "@console/i18n/format";
import { labeled, RECORD_STATUS } from "../../../lib/labels";
import { Chip } from "../../../ui/chip";
import { Table } from "../../../ui/table";
import { addressLine, headcount, registrationOf, registrationTodo } from "../domain/view";
import s from "./record.module.css";
import { Muted } from "../../../ui/muted/muted";
import { InsuranceSummary } from "../../../reference/entity/ui/insurance-summary";

/** workplaces and certificates (spec S3): every workplace with its headcount, its certificate's number and status, place and social insurance. */
export function WorkplacesCard({ e }: { e: LegalEntity }) {
  const nav = useNavigate();
  const vat = e.current?.vat_unit_mode;
  return (
    <section className="card" aria-labelledby="workplaces-title">
      <div className={s.cardHead}>
        <h2 id="workplaces-title" className={s.cardTitle}>{t("entityRecord.workplaces.title")}</h2>
        <span className="muted">
          {t("entityRecord.workplaces.summary", { count: e.workplaces.length, people: fmtNumber(headcount(e)) })}
          {vat && ` · ${t("entityRecord.workplaces.vat", { mode: t(`entity.vat.${vat}`) })}`}
        </span>
        <span className="grow" />
        {!e.read_only && !e.closed_on && <Link to="/org/entities/$id/workplaces/new" params={{ id: e.id }} className="btn btn--ghost"><Plus size={16} aria-hidden /> {t("entityRecord.workplaces.add")}</Link>}
      </div>
      {e.workplaces.length === 0 ? (
        <p className={`muted ${s.cardBody}`}>{t("entityRecord.workplaces.none")}</p>
      ) : (
        <Table
          label={t("entityRecord.workplaces.table")}
          rows={e.workplaces}
          rowId={(w) => w.id}
          onSelect={(id) => void nav({ to: "/org/entities/$id", params: { id: e.id }, search: { wp: id, as_of: e.as_of, known_at: e.known_at ?? undefined } })}
          columns={[
            {
              header: t("entityRecord.workplaces.col.name"),
              cell: (w) => (
                <span className="row">
                  <b>{w.current?.name}</b>
                  {w.is_head_office && <Chip tone="neutral">{t("entityRecord.workplaces.head")}</Chip>}
                  {w.is_primary && <Chip tone="neutral">{t("entityRecord.workplaces.primary")}</Chip>}
                </span>
              ),
            },
            { header: t("entityRecord.workplaces.col.people"), cell: (w) => <b className="num">{fmtNumber(w.headcount)}</b>, fit: true },
            { header: t("entityRecord.workplaces.col.brn"), cell: (w) => {
              const brn = registrationOf(e, w.registration_id ?? w.filing_registration_id)?.brn?.display;
              return <span className="code">{w.registration_id ? brn ?? t("workplace.brnPending") : <>{t("workplace.filing.entityBasis")}{brn && ` · ${brn}`}</>}</span>;
            }, fit: true },
            {
              header: t("entityRecord.workplaces.col.status"),
              fit: true,
              cell: (w) => {
                const r = registrationOf(e, w.registration_id);
                if (!r?.current) return registrationTodo(w) ? <Muted>{t("workplace.registration.prompt")}</Muted> : <Chip tone="neutral">{w.not_registered_reason?.label ?? "—"}</Chip>;
                const st = labeled(RECORD_STATUS, r.current.status);
                return <Chip tone={st.tone}>{st.label}</Chip>;
              },
            },
            { header: t("entityRecord.workplaces.col.address"), cell: (w) => <Muted>{addressLine(w.current?.address ?? registrationOf(e, w.registration_id)?.current?.business_address) || "—"}</Muted>, wide: true },
            { header: t("entityRecord.workplaces.col.insurance"), cell: w => <InsuranceSummary insurance={w.insurance} />, fit: true },
            { header: <span className="sr-only">{t("entityRecord.workplaces.col.open")}</span>, cell: () => <ChevronRight size={14} aria-hidden />, fit: true },
          ]}
        />
      )}
    </section>
  );
}
