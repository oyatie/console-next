import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { LegalEntity } from "@console/api/pending";
import { t } from "@console/i18n";
import { buttonClass } from "../../../ui/button/button-class";
import { Button } from "../../../ui/button/button";
import { identityProblems } from "../../../reference/entity/domain/names";

/**
 * The server's typed identity problems. In the list each opens its record; on the record (`onCertificate`) the name rows
 * are the fix for person data, the certificate tab for evidence, and a review offers its two names.
 */
export function NameProblems({ e, onCertificate, review }: { e: LegalEntity; onCertificate?: () => void; review?: (r: NonNullable<LegalEntity["name_reviews"]>[number]) => ReactNode }) {
  const problems = identityProblems(e).filter((code) => code !== "legal_name_review" || !onCertificate);
  const reviews = review ? e.name_reviews ?? [] : [];
  if (!problems.length && !reviews.length) return null;
  const evidence = (code: string) => code === "legal_name_unconfirmed" || code === "primary_registration_classification";
  return <ul>
    {problems.map((code) => <li key={code} data-problem={code}>
      {t(`entity.name.${code}`)}{" "}
      {!onCertificate ? <Link className={buttonClass("ghost")} onClick={(event) => event.stopPropagation()} to="/org/entities/$id" params={{ id: e.id }}>{t("entity.name.open")}</Link>
        : evidence(code) && <Button variant="ghost" onClick={onCertificate}>{t("entity.name.recordCertificate")}</Button>}
    </li>)}
    {review && reviews.map((r) => review(r))}
  </ul>;
}
