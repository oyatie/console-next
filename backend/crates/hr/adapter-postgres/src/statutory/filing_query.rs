use super::FilingQuery;
use crate::HrError;
use crate::authz::{Tier, hr_reach_in, push_reach};
use console_hr_domain::profile::enums::{EmploymentType, WorkerClassification};
use console_platform_authz::{Feature, Principal};
use sqlx::{Postgres, QueryBuilder, Transaction, postgres::PgRow};

// ponytail: current `profile.employment_type` is used; dated classification
// (a 파견→REGULAR 전환 via EMPLOYMENT_TYPE_CHANGE) is a known ceiling →
// WPO-WORKER-FACETS / WPO-ENGAGEMENTS.
pub(super) fn non_employee_types() -> Vec<&'static str> {
    EmploymentType::ALL
        .iter()
        .copied()
        .filter(|t| {
            matches!(
                t.worker_classification(),
                WorkerClassification::DispatchedIn
                    | WorkerClassification::OutsourcedOnSite
                    | WorkerClassification::PlatformOrFreelance
            )
        })
        .map(EmploymentType::as_str)
        .collect()
}
// Historical placement, including both employers of a 전적. No current-employer scope shortcut.
const FROM: &str = " FROM sources l \
 JOIN employees x ON x.org_id = l.org_id AND x.id = l.employee_id \
 CROSS JOIN LATERAL (SELECT k FROM unnest(CASE \
   WHEN l.event_type = 'GROUP_TRANSFER' THEN ARRAY['LOSE','ACQUIRE','AGE60'] \
   WHEN l.event_type IN ('ONBOARD','REHIRE') THEN ARRAY['ACQUIRE','AGE60'] \
   WHEN l.event_type IN ('TERMINATE','OFFBOARD') THEN ARRAY['LOSE'] \
   WHEN l.event_type = 'LEAVE_OF_ABSENCE' THEN ARRAY['LEAVE'] \
   WHEN l.event_type = 'RETURN_FROM_LEAVE' THEN ARRAY['RESUME'] WHEN l.event_type = 'STATUTORY_REQUEST' THEN ARRAY[l.request_kind] ELSE ARRAY[]::text[] END) k) kind \
 CROSS JOIN unnest(ARRAY['NPS','NHIS','EI','IACI']) agency(insurer) \
 CROSS JOIN LATERAL (SELECT x.id, x.org_id, x.name, x.employee_number, x.home_branch_id, \
   CASE WHEN kind.k IN ('LOSE','SEPARATION_CERTIFICATE') THEN COALESCE(l.from_org_unit_id, x.org_unit_id) \
        ELSE COALESCE(l.to_org_unit_id, x.org_unit_id) END AS org_unit_id) e \
 LEFT JOIN LATERAL (SELECT a.legal_entity_id, a.workplace_id FROM employment_assignments a \
   WHERE a.org_id = l.org_id AND a.employee_id = l.employee_id AND a.superseded_at IS NULL \
     AND a.valid_from <= l.placement_date::date \
     AND (l.source_type <> 'GROUP_TRANSFER' OR kind.k NOT IN ('LOSE','SEPARATION_CERTIFICATE') OR a.valid_from < l.placement_date::date) \
   ORDER BY a.valid_from DESC LIMIT 1) ea ON TRUE \
 LEFT JOIN LATERAL (SELECT r.* FROM insurance_filing_records r \
   WHERE r.org_id = l.org_id AND (r.event_id = l.id OR r.request_id = l.id) AND r.insurer = agency.insurer AND r.filing_kind = kind.k \
   ORDER BY r.version DESC LIMIT 1) receipt ON TRUE \
 LEFT JOIN LATERAL (SELECT min(r.anchor_on)::text AS requested_acquisition_on FROM insurance_filing_requests r WHERE r.org_id=l.org_id AND r.source_event_id=l.id AND r.filing_kind='ACQUIRE_REQUESTED') urgency ON TRUE \
 LEFT JOIN employee_employment_profiles profile ON profile.org_id=x.org_id AND profile.employee_id=x.id \
 LEFT JOIN employee_personal_facts personal ON personal.org_id=x.org_id AND personal.employee_id=x.id \
 LEFT JOIN LATERAL (SELECT r.applicability_facts FROM insurance_filing_records r WHERE r.org_id=l.org_id AND (r.event_id=l.id OR r.request_id=l.id) AND r.insurer=agency.insurer AND r.filing_kind=kind.k AND r.applicability_facts IS NOT NULL ORDER BY r.version DESC LIMIT 1) assessment ON TRUE \
 LEFT JOIN LATERAL (SELECT r.action,r.version FROM insurance_filing_records r WHERE r.org_id=l.org_id AND (r.event_id=l.id OR r.request_id=l.id) AND r.insurer='EI' AND r.filing_kind=kind.k ORDER BY r.version DESC LIMIT 1) ei ON TRUE \
 WHERE l.state IN ('APPLIED','SCHEDULED') AND x.voided_at IS NULL \
   AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v \
     WHERE v.org_id = l.org_id AND v.voids_event_id = COALESCE(l.source_event_id,l.id) AND v.state = 'APPLIED')";

pub(super) async fn rows(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    query: &FilingQuery,
) -> Result<Vec<PgRow>, HrError> {
    let reach = hr_reach_in(principal, Feature::EmployeeDirectoryManage, Tier::Branch)?;
    let mut q = QueryBuilder::<Postgres>::new(
        "WITH sources AS (SELECT id,org_id,employee_id,event_type,state,effective_date,created_at,from_org_unit_id,to_org_unit_id,NULL::text AS request_kind,NULL::uuid AS source_event_id,effective_date AS placement_date,event_type AS source_type FROM employee_lifecycle_events UNION ALL \
      SELECT r.id,r.org_id,r.employee_id,'STATUTORY_REQUEST',p.state,r.anchor_on::text,r.created_at,p.from_org_unit_id,p.to_org_unit_id,r.filing_kind,r.source_event_id,p.effective_date,p.event_type FROM insurance_filing_requests r JOIN employee_lifecycle_events p ON p.org_id=r.org_id AND p.id=r.source_event_id WHERE r.filing_kind<>'ACQUIRE_REQUESTED'), filtered AS (SELECT l.id, l.created_at, \
      'insurance_filing_' || kind.k || '_' || agency.insurer || ':' || l.id AS inbox_id, l.employee_id, e.name, e.employee_number, kind.k AS kind, \
      agency.insurer AS insurer, CASE WHEN l.event_type = 'GROUP_TRANSFER' AND kind.k = 'LOSE' THEN (l.effective_date::date - 1)::text ELSE l.effective_date END AS effective_date, ea.legal_entity_id, ea.workplace_id, \
      (SELECT w.name FROM workplace_revisions w WHERE w.org_id = l.org_id AND w.workplace_id = ea.workplace_id \
         AND w.effective_from <= l.placement_date::date ORDER BY w.effective_from DESC, w.version DESC LIMIT 1) AS workplace_name, \
      COALESCE(receipt.version, 0) AS version, \
      CASE WHEN receipt.action = 'COMPLETE' THEN receipt.completed_on::text END AS completed_on, \
      receipt.receipt_number, receipt.loss_code, receipt.detail, receipt.action,receipt.not_applicable_reason,receipt.total_remuneration_won,assessment.applicability_facts,ei.action AS ei_action, x.birth_date::text AS birth_date, \
      (SELECT max(h.effective_date::date)::text FROM employee_lifecycle_events h WHERE h.org_id=l.org_id AND h.employee_id=l.employee_id AND h.event_type IN ('ONBOARD','REHIRE','GROUP_TRANSFER') AND h.state='APPLIED' AND h.effective_date::date<=l.placement_date::date AND (l.source_type<>'GROUP_TRANSFER' OR kind.k NOT IN ('LOSE','SEPARATION_CERTIFICATE') OR h.effective_date::date<l.placement_date::date) AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id=h.org_id AND v.voids_event_id=h.id AND v.state='APPLIED')) AS acquired_on, \
      (SELECT min(CASE WHEN h.event_type='GROUP_TRANSFER' THEN h.effective_date::date-1 ELSE h.effective_date::date END)::text FROM employee_lifecycle_events h WHERE h.org_id=l.org_id AND h.employee_id=l.employee_id AND h.event_type IN ('TERMINATE','OFFBOARD','GROUP_TRANSFER') AND h.state IN ('APPLIED','SCHEDULED') AND h.effective_date::date>l.effective_date::date AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id=h.org_id AND v.voids_event_id=h.id AND v.state='APPLIED')) AS ended_on, \
      profile.employment_type,personal.nationality,l.event_type,l.source_event_id,urgency.requested_acquisition_on",
    );
    q.push(FROM)
        .push(" AND l.org_id = ")
        .push_bind(*principal.org_id.as_uuid())
        .push(" AND (profile.employment_type IS NULL OR profile.employment_type <> ALL(")
        .push_bind(non_employee_types())
        .push("))")
        .push(" AND ");
    q.push(" (kind.k='AGE60' OR ");
    push_reach(&mut q, &reach);
    q.push(")");
    // These candidates are absent under the shared assessment, including its stored-facts fallback.
    q.push(" AND (kind.k <> 'AGE60' OR (agency.insurer = 'NPS' \
      AND COALESCE(x.birth_date::text, assessment.applicability_facts->>'birth_date') IS NOT NULL))");
    if query.inbox_scan_limit.is_some() {
        // Birthday tasks use their projected birthday key in the companion read.
        q.push(" AND kind.k <> 'AGE60'");
    }
    if let Some(as_of) = query.inbox_as_of {
        q.push(" AND l.created_at <= ").push_bind(as_of);
    }
    for (column, value) in [
        ("ea.workplace_id", query.workplace_id),
        ("ea.legal_entity_id", query.legal_entity_id),
        ("l.id", query.event_id),
    ] {
        if let Some(id) = value {
            if column == "l.id" {
                q.push(" AND l.id = ").push_bind(id);
            } else {
                q.push(" AND (kind.k='AGE60' OR ")
                    .push(column)
                    .push(" = ")
                    .push_bind(id)
                    .push(")");
            }
        }
    }
    if let Some(search) = query.search.as_ref().filter(|s| !s.trim().is_empty()) {
        q.push(" AND (e.name ILIKE ")
            .push_bind(format!("%{}%", search.trim()))
            .push(" OR e.employee_number ILIKE ")
            .push_bind(format!("%{}%", search.trim()))
            .push(")");
    }
    for (column, value) in [
        ("agency.insurer", query.insurer.as_ref()),
        ("kind.k", query.kind.as_ref()),
    ] {
        if let Some(value) = value {
            q.push(" AND ").push(column).push(" = ").push_bind(value);
        }
    }
    q.push(") SELECT * FROM filtered");
    push_page_order(&mut q, query);
    Ok(q.build().fetch_all(tx.as_mut()).await?)
}

fn push_page_order(q: &mut QueryBuilder<Postgres>, query: &FilingQuery) {
    if let Some(limit) = query.inbox_scan_limit {
        if let Some((created_at, id)) = &query.inbox_after {
            q.push(" WHERE (created_at, inbox_id) > (")
                .push_bind(*created_at)
                .push(", ")
                .push_bind(id.clone())
                .push(")");
        }
        q.push(" ORDER BY created_at, inbox_id LIMIT ")
            .push_bind(i64::try_from(limit).unwrap_or(i64::MAX));
    } else {
        q.push(" ORDER BY effective_date,id,kind,insurer");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[allow(clippy::unwrap_used)]
    fn only_internal_candidate_reads_bound_and_use_the_immutable_cursor() {
        let after = Some((
            time::OffsetDateTime::UNIX_EPOCH,
            "insurance_filing_ACQUIRE_NPS:record".into(),
        ));
        let mut query = FilingQuery {
            inbox_after: after,
            limit: Some(1),
            ..FilingQuery::default()
        };
        let mut ordinary = QueryBuilder::<Postgres>::new("SELECT * FROM filtered");
        push_page_order(&mut ordinary, &query);
        assert_eq!(
            ordinary.sql(),
            "SELECT * FROM filtered ORDER BY effective_date,id,kind,insurer"
        );
        query.inbox_scan_limit = Some(50);
        let mut bounded = QueryBuilder::<Postgres>::new("SELECT * FROM filtered");
        push_page_order(&mut bounded, &query);
        assert_eq!(
            bounded.sql(),
            "SELECT * FROM filtered WHERE (created_at, inbox_id) > ($1, $2) ORDER BY created_at, inbox_id LIMIT $3"
        );
        let external: FilingQuery =
            serde_json::from_value(serde_json::json!({"inbox_scan_limit": 50})).unwrap();
        assert!(
            external.inbox_scan_limit.is_none(),
            "HTTP input cannot switch the read into a partial candidate scan"
        );
    }

    #[test]
    fn non_employee_types_derives_dispatched_outsourced_and_freelance_only() {
        assert_eq!(
            non_employee_types(),
            vec!["DISPATCHED_IN", "OUTSOURCED_ON_SITE", "FREELANCE"]
        );
    }
}
