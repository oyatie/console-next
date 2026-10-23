// SPDX-License-Identifier: LicenseRef-Proprietary
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { t } from "@console/i18n";
import { fmtDate } from "@console/i18n/format";
import { QueryState } from "../../../lib/react/query-state";
import { Button } from "../../../ui/button/button";
import { Chip } from "../../../ui/chip";
import { personBindingReviewsQuery } from "../api";

/** A legacy flag or open binding evidence leads to the same identity review. */
export function BindingReviewChip({ subjectId, required, onOpen }: { subjectId: string; required?: boolean; onOpen: () => void }) {
  const reviews = useQuery(personBindingReviewsQuery(subjectId));
  if (!required && !reviews.data?.total) return null;
  return <><Chip tone="warn">{t("people.identityReview")}</Chip><Button variant="ghost" onClick={onOpen}>{t("person.identity")}</Button></>;
}

/** Scoped evidence names the other records; verdict explanations belong to the decision form. */
export function BindingEvidence({ subjectId, employeeId }: { subjectId: string; employeeId?: string }) {
  const reviews = useQuery(personBindingReviewsQuery(subjectId));
  return <QueryState q={reviews}>{(page) => {
    const candidates = [...new Map(page.items.flatMap((r) => r.evidence.candidates)
      .filter((c) => c.employee_id !== employeeId).map((c) => [c.employee_id, c])).values()];
    return candidates.length > 0 && <section aria-label={t("identity.binding.title")}>
      <ul className="list-plain">{candidates.map((candidate) => <li key={candidate.employee_id} className="row">
        <Link to="/people/$id" params={{ id: candidate.employee_id }} search={{}}>
          {t("people.sameName.other", { name: candidate.name, number: candidate.employee_number ?? "—" })}
        </Link>
        {candidate.birth_date && <time dateTime={candidate.birth_date}>{fmtDate(candidate.birth_date)}</time>}
      </li>)}</ul>
    </section>;
  }}</QueryState>;
}
