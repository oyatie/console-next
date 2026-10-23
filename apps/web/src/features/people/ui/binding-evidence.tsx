// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Link } from "@tanstack/react-router";
import { personBindingReviewsQuery } from "../api";

/** Read-only system evidence alongside the existing HR identity decision. */
export function BindingEvidence({ employeeId }: { employeeId: string }) {
  const reviews = useQuery(personBindingReviewsQuery(employeeId));
  return <QueryState q={reviews}>{(page) => (<>
    <p>{t(page.items.length > 0 ? "identity.binding.note" : "identity.fact")}</p>
    {page.items.length > 0 && (
    <section aria-label={t("identity.binding.title")}>
      <ul>{page.items.flatMap((review) => review.evidence.candidates).map((candidate) => (
        <li key={candidate.employee_id}>
          <Link to="/people/$id" params={{ id: candidate.employee_id }}>
            {t("identity.binding.candidate", { birth: candidate.birth_date ? fmtDate(candidate.birth_date) : t("person.field.notSet") })}
          </Link>
        </li>
      ))}</ul>
    </section>
  )}</>)}</QueryState>;
}
