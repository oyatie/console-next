import { t } from "@console/i18n";
import { Link } from "@tanstack/react-router";
import { Fragment } from "react";
import { EntityName } from "../../../reference/entity/ui/entity-name";
import { Banner } from "../../../ui/banner/banner";
import type { CompanyConfirmation as Evidence } from "../domain/contract";

/** Source aliases remain visible in the applied run until its employer is confirmed. */
export function CompanyConfirmation({ evidence }: { evidence: Evidence }) {
  return <Banner tone="warn" title={t("importReview.reason.company_unconfirmed")}>
    <p>{t("importReconcile.company.source", { value: evidence.value, column: evidence.source_column ?? "—", cell: evidence.cell ?? "—" })}{evidence.registration_number && <> · {t("importReconcile.company.number", { number: evidence.registration_number })}</>}</p>
    {evidence.candidates.length > 0 && <p>{t("importReconcile.company.candidates")} {evidence.candidates.map((c, i) => <Fragment key={c.id}>{i > 0 && " · "}<EntityName name={c.name} alias={c.alias} /></Fragment>)}</p>}
    <p>{evidence.confirmed_employer ? t("importReconcile.company.assigned", { name: evidence.confirmed_employer }) : t("importReconcile.company.next")}</p>
    {!evidence.confirmed_employer && <Link to="/people/unplaced">{t("unplaced.title")}</Link>}
  </Banner>;
}
