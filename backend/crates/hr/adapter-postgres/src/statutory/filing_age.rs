// SPDX-License-Identifier: LicenseRef-Proprietary
//! Project the assessment's birthday key before the inbox keyset and hydration.
use super::FilingQuery;
use crate::HrError;
use console_compliance_domain::statutory::StatutoryRegister;
use sqlx::{Postgres, QueryBuilder};

pub(super) fn candidates(
    q: &mut QueryBuilder<Postgres>,
    query: &FilingQuery,
    register: &StatutoryRegister,
) -> Result<(), HrError> {
    if query.kind.as_deref().is_some_and(|kind| kind != "AGE60")
        || (query.inbox_scan_limit.is_some() && query.kind.as_deref() != Some("AGE60"))
    {
        q.push("), candidates AS (SELECT filtered.*,source_created_at AS created_at FROM filtered");
        return Ok(());
    }
    // Batch source placement: resolving it per candidate would move the N+1 before LIMIT.
    q.push("), age_rules AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(")
        .push_bind(serde_json::to_value(register.filing_rules()).map_err(|e| HrError::internal(e.to_string()))?)
        .push(") AS r(filing_kind text,insurer text,effective_from date,effective_to_exclusive date,age_trigger_years int) \
          WHERE filing_kind='AGE60' AND insurer='NPS' AND age_trigger_years IS NOT NULL), \
        age_assignments AS MATERIALIZED (SELECT a.* FROM employment_assignments a WHERE a.org_id=(SELECT org_id FROM boundary) AND a.superseded_at IS NULL), \
        age_placements AS MATERIALIZED (SELECT DISTINCT ON (l.id,l.recording_held) l AS candidate,COALESCE(w.time_zone,e.time_zone,p.time_zone) AS time_zone \
          FROM filtered l CROSS JOIN lifecycle_country_packs p \
          LEFT JOIN age_assignments a ON a.employee_id=l.employee_id AND a.valid_from<=l.placement_date::date \
          LEFT JOIN workplaces w ON w.org_id=l.org_id AND w.id=a.workplace_id \
          LEFT JOIN legal_entities e ON e.org_id=l.org_id AND e.id=COALESCE(w.legal_entity_id,a.legal_entity_id) \
          WHERE l.kind='AGE60' AND p.is_default ORDER BY l.id,l.recording_held,a.valid_from DESC), \
        age_endings AS MATERIALIZED (SELECT h.employee_id,h.effective_date::date AS source_on, \
          CASE WHEN h.event_type='GROUP_TRANSFER' THEN h.effective_date::date-1 ELSE h.effective_date::date END AS ended_on \
          FROM employee_lifecycle_events h WHERE h.org_id=(SELECT org_id FROM boundary) \
            AND h.event_type IN ('TERMINATE','OFFBOARD','GROUP_TRANSFER') AND h.state IN ('APPLIED','SCHEDULED') \
            AND NOT EXISTS(SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id=h.org_id AND v.voids_event_id=h.id AND v.state='APPLIED')), \
        age_clock AS MATERIALIZED (SELECT p.*,(COALESCE(")
        .push_bind(query.inbox_as_of)
        .push(",now()) AT TIME ZONE p.time_zone)::date AS today FROM age_placements p), \
        age_candidates AS (SELECT (p.candidate).*,GREATEST((p.candidate).source_created_at,b.birthday::timestamp AT TIME ZONE p.time_zone) AS created_at \
          FROM age_clock p \
          JOIN age_rules r ON r.effective_from<=p.today AND (r.effective_to_exclusive IS NULL OR p.today<r.effective_to_exclusive) \
          CROSS JOIN LATERAL (SELECT ((p.candidate).assessment_birth_date::date+make_interval(years=>r.age_trigger_years))::date AS birthday) b \
          WHERE (p.candidate).kind='AGE60'");
    if query.inbox_scan_limit.is_some() {
        // A superset of assess: terminal receipts, deadlines and Cedar placement remain authoritative there.
        q.push(" AND b.birthday>(p.candidate).source_on AND b.birthday<=p.today \
          AND NOT EXISTS (SELECT 1 FROM age_endings h WHERE h.employee_id=(p.candidate).employee_id AND h.source_on>(p.candidate).source_on AND h.ended_on<=b.birthday)");
    }
    q.push("), candidates AS (SELECT filtered.*,source_created_at AS created_at FROM filtered WHERE kind<>'AGE60' UNION ALL SELECT * FROM age_candidates");
    Ok(())
}
