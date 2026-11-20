// SPDX-License-Identifier: LicenseRef-Proprietary
// Ranking assesses every candidate; materialize each tenant fact set once.
pub(super) const RANKING_CTES: &str = ", ranking_people AS MATERIALIZED (SELECT * FROM person_employees_current_set WHERE org_id=(SELECT org_id FROM boundary)), \
 ranking_assignments AS MATERIALIZED (SELECT a.*,lead(a.valid_from) OVER (PARTITION BY a.org_id,a.employee_id ORDER BY a.valid_from) AS next_from \
   FROM employment_assignments a WHERE a.org_id=(SELECT org_id FROM boundary) AND a.superseded_at IS NULL)";

// Keep employee and void lookups indexed before tenant statistics catch up.
// Filter and order candidates before hydrating receipts, history and case links.
pub(super) const FROM_INDEXED: &str = " FROM sources l \
 JOIN LATERAL (SELECT * FROM person_employees_current WHERE org_id=l.org_id AND id=l.employee_id OFFSET 0) x ON true \
 LEFT JOIN LATERAL (SELECT a.workplace_id FROM employment_assignments a WHERE a.org_id=l.org_id AND a.employee_id=l.employee_id \
   AND a.superseded_at IS NULL AND a.valid_from<l.effective_date::date AND l.to_workplace_id IS NOT NULL ORDER BY a.valid_from DESC LIMIT 1) previous ON true ";

pub(super) const FROM_SET: &str = " FROM sources l JOIN ranking_people x ON x.org_id=l.org_id AND x.id=l.employee_id \
 LEFT JOIN ranking_assignments previous ON previous.org_id=l.org_id AND previous.employee_id=l.employee_id \
   AND l.to_workplace_id IS NOT NULL AND previous.valid_from<l.effective_date::date \
   AND (previous.next_from IS NULL OR previous.next_from>=l.effective_date::date) ";

pub(super) fn placement(lightweight: bool) -> &'static str {
    if lightweight {
        // The next start bounds the same latest-start lookup, including the transfer's A side.
        " LEFT JOIN ranking_assignments ea ON ea.org_id=l.org_id AND ea.employee_id=l.employee_id \
          AND CASE WHEN l.source_type='GROUP_TRANSFER' AND kind.k IN ('LOSE','SEPARATION_CERTIFICATE') \
            THEN ea.valid_from<l.placement_date::date AND (ea.next_from IS NULL OR ea.next_from>=l.placement_date::date) \
            ELSE ea.valid_from<=l.placement_date::date AND (ea.next_from IS NULL OR ea.next_from>l.placement_date::date) END "
    } else {
        " LEFT JOIN LATERAL (SELECT a.legal_entity_id, a.workplace_id FROM employment_assignments a \
          WHERE a.org_id = l.org_id AND a.employee_id = l.employee_id AND a.superseded_at IS NULL \
            AND a.valid_from <= l.placement_date::date \
            AND (l.source_type <> 'GROUP_TRANSFER' OR kind.k NOT IN ('LOSE','SEPARATION_CERTIFICATE') OR a.valid_from < l.placement_date::date) \
          ORDER BY a.valid_from DESC LIMIT 1) ea ON TRUE "
    }
}
