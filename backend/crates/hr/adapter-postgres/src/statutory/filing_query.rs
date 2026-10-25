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
// Filter and order candidates before hydrating receipts, history and case links.
const FROM: &str = " FROM sources l \
 JOIN person_employees_current x ON x.org_id = l.org_id AND x.id = l.employee_id \
 LEFT JOIN LATERAL (SELECT a.workplace_id FROM employment_assignments a WHERE a.org_id=l.org_id AND a.employee_id=l.employee_id \
   AND a.superseded_at IS NULL AND a.valid_from<l.effective_date::date AND l.to_workplace_id IS NOT NULL ORDER BY a.valid_from DESC LIMIT 1) previous ON true \
 CROSS JOIN LATERAL (SELECT DISTINCT r.filing_kind AS k,r.insurer,r.recording_held, \
   r.earliest_event_on FROM rules r \
   WHERE ((r.effective_from<=l.effective_date::date+r.loss_days \
     AND (r.effective_to_exclusive IS NULL OR l.effective_date::date+r.loss_days<r.effective_to_exclusive)) OR r.is_age) \
     AND (NOT r.requires_workplace_change OR (previous.workplace_id IS DISTINCT FROM l.to_workplace_id AND l.to_workplace_id IS NOT NULL)) \
     AND (l.event_type=ANY(r.trigger_event_kinds) OR (l.event_type='STATUTORY_REQUEST' AND r.filing_kind=l.request_kind))) rule \
 CROSS JOIN LATERAL (SELECT rule.k) kind CROSS JOIN LATERAL (SELECT rule.insurer) agency \
 CROSS JOIN LATERAL (SELECT x.id, x.org_id, x.name, x.employee_number, x.home_branch_id, \
   CASE WHEN kind.k IN ('LOSE','SEPARATION_CERTIFICATE') THEN COALESCE(l.from_org_unit_id, x.org_unit_id) \
        ELSE COALESCE(l.to_org_unit_id, x.org_unit_id) END AS org_unit_id) e \
 LEFT JOIN employee_employment_profiles profile ON profile.org_id=x.org_id AND profile.employee_id=x.id \
 LEFT JOIN LATERAL (SELECT (SELECT r.applicability_facts FROM insurance_filing_records r WHERE r.org_id=l.org_id AND (r.event_id=l.id OR r.request_id=l.id) AND r.insurer=agency.insurer AND r.filing_kind=kind.k AND r.applicability_facts IS NOT NULL ORDER BY r.version DESC LIMIT 1) AS applicability_facts) assessment ON TRUE \
";
const PLACEMENT: &str = " LEFT JOIN LATERAL (SELECT a.legal_entity_id, a.workplace_id FROM employment_assignments a \
   WHERE a.org_id = l.org_id AND a.employee_id = l.employee_id AND a.superseded_at IS NULL \
     AND a.valid_from <= l.placement_date::date \
     AND (l.source_type <> 'GROUP_TRANSFER' OR kind.k NOT IN ('LOSE','SEPARATION_CERTIFICATE') OR a.valid_from < l.placement_date::date) \
   ORDER BY a.valid_from DESC LIMIT 1) ea ON TRUE \
";
const FILING: &str = " LEFT JOIN filing_obligations f ON f.org_id=l.org_id AND f.event_id=l.id AND f.filing_kind=kind.k AND f.insurer=agency.insurer \
";
const WHERE: &str = " WHERE l.state IN ('APPLIED','SCHEDULED') AND x.voided_at IS NULL \
   AND (rule.earliest_event_on IS NULL OR l.effective_date::date >= rule.earliest_event_on \
     OR (kind.k='ACQUIRE' AND agency.insurer='EI' AND EXISTS(SELECT 1 FROM insurance_filing_requests r WHERE r.org_id=l.org_id AND r.source_event_id=l.id AND r.filing_kind='ACQUIRE_REQUESTED'))) \
   AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v \
     WHERE v.org_id = l.org_id AND v.voids_event_id = COALESCE(l.source_event_id,l.id) AND v.state = 'APPLIED')";

pub(super) async fn rows(
    tx: &mut Transaction<'_, Postgres>,
    principal: &Principal,
    query: &FilingQuery,
) -> Result<Vec<PgRow>, HrError> {
    let bounds = super::filing_boundary::load(tx, *principal.org_id.as_uuid()).await?;
    let reach = hr_reach_in(principal, Feature::EmployeeDirectoryManage, Tier::Branch)?;
    let placement_filter = query.workplace_id.is_some()
        || query.legal_entity_id.is_some()
        || matches!(&reach, crate::authz::HrReach::Within { scope, .. } if !scope.is_empty());
    // A constant lower bound across tenant zones avoids recalculating placement
    // for every excluded candidate. The exact check still uses the owning zone.
    let mut q = QueryBuilder::<Postgres>::new(
        "WITH boundary AS MATERIALIZED (SELECT tenant.id AS org_id,COALESCE(phase.go_live_at,now()) AS go_live_at,min((COALESCE(phase.go_live_at,now()) AT TIME ZONE zones.time_zone)::date) AS go_live_on \
         FROM (SELECT ",
    );
    q.push_bind(*principal.org_id.as_uuid()).push(
        "::uuid AS id) tenant LEFT JOIN tenant_phase phase ON phase.org_id=tenant.id \
         CROSS JOIN LATERAL (SELECT time_zone FROM lifecycle_country_packs WHERE is_default \
           UNION SELECT time_zone FROM workplaces WHERE org_id=tenant.id \
           UNION SELECT time_zone FROM legal_entities WHERE org_id=tenant.id) zones GROUP BY tenant.id,phase.go_live_at), \
         sources AS (SELECT id,org_id,employee_id,event_type,state,effective_date,created_at,from_org_unit_id,to_org_unit_id,to_workplace_id,NULL::text AS request_kind,NULL::uuid AS source_event_id,effective_date AS placement_date,event_type AS source_type FROM employee_lifecycle_events WHERE org_id=(SELECT org_id FROM boundary) UNION ALL \
           SELECT r.id,r.org_id,r.employee_id,'STATUTORY_REQUEST',p.state,r.anchor_on::text,r.created_at,p.from_org_unit_id,p.to_org_unit_id,p.to_workplace_id,r.filing_kind,r.source_event_id,p.effective_date,p.event_type FROM insurance_filing_requests r JOIN employee_lifecycle_events p ON p.org_id=r.org_id AND p.id=r.source_event_id WHERE r.filing_kind<>'ACQUIRE_REQUESTED' AND r.org_id=(SELECT org_id FROM boundary)), \
         source_bounds AS MATERIALIZED (SELECT min(effective_date::date) AS first_on,max(effective_date::date) AS last_on FROM sources), \
         rules AS MATERIALIZED (SELECT DISTINCT CASE WHEN r.filing_rule->>'age_trigger_years' IS NULL THEN r.effective_from END AS effective_from, \
           CASE WHEN r.filing_rule->>'age_trigger_years' IS NULL THEN r.effective_to_exclusive END AS effective_to_exclusive, \
           r.recording_held,r.requires_workplace_change,r.trigger_event_kinds, \
           r.filing_rule->>'filing_kind' AS filing_kind,r.filing_rule->>'insurer' AS insurer, \
           CASE WHEN r.filing_rule->>'age_trigger_years' IS NULL THEN COALESCE((r.filing_rule->>'loss_offset_days')::int,0) ELSE 0 END AS loss_days,r.filing_rule->>'age_trigger_years' IS NOT NULL AS is_age, \
           cutoff.earliest_event_on \
           FROM lifecycle_filing_rules r JOIN jsonb_to_recordset(",
    );
    q.push_bind(bounds).push(
        ") AS cutoff(code text,effective_from date,earliest_event_on date) ON cutoff.code=r.code AND cutoff.effective_from=r.effective_from CROSS JOIN source_bounds b WHERE r.filing_rule IS NOT NULL \
             AND (r.filing_rule->>'age_trigger_years' IS NOT NULL OR (r.effective_from<=b.last_on+COALESCE((r.filing_rule->>'loss_offset_days')::int,0) \
               AND (r.effective_to_exclusive IS NULL OR b.first_on+COALESCE((r.filing_rule->>'loss_offset_days')::int,0)<r.effective_to_exclusive)))), \
      filtered AS (SELECT l.id,l.org_id,l.created_at, \
      'insurance_filing_' || kind.k || '_' || agency.insurer || ':' || l.id AS inbox_id,l.employee_id, \
      kind.k AS kind,agency.insurer AS insurer,rule.recording_held, \
      CASE WHEN l.event_type='GROUP_TRANSFER' AND kind.k='LOSE' THEN (l.effective_date::date-1)::text ELSE l.effective_date END AS effective_date, \
      l.effective_date::date AS source_on,l.placement_date,l.source_type,l.source_event_id,l.event_type, \
      x.name,x.employee_number,x.birth_date::text,profile.employment_type",
    );
    if placement_filter {
        q.push(",ea.legal_entity_id,ea.workplace_id");
    }
    q.push(FROM);
    if placement_filter {
        q.push(PLACEMENT);
    }
    if query.filing_id.is_some() {
        q.push(FILING);
    }
    q.push(WHERE)
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
    if let Some(id) = query.filing_id {
        q.push(" AND f.id = ").push_bind(id);
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
    q.push("), paged AS MATERIALIZED (SELECT * FROM filtered");
    let order = push_page_order(&mut q, query);
    // Resolve each selected workplace once; unplaced legacy rows keep the employee fallback.
    q.push("), hydrated AS MATERIALIZED (SELECT l.*,");
    if !placement_filter {
        q.push("ea.legal_entity_id,ea.workplace_id,");
    }
    q.push("l.placement_date::date AS placement_on,f.id AS filing_obligation_id,personal.nationality, \
      (SELECT r.applicability_facts FROM insurance_filing_records r WHERE r.org_id=l.org_id AND (r.event_id=l.id OR r.request_id=l.id) AND r.insurer=l.insurer AND r.filing_kind=l.kind AND r.applicability_facts IS NOT NULL ORDER BY r.version DESC LIMIT 1) AS applicability_facts, \
      (SELECT i.case_id FROM lifecycle_case_items i JOIN lifecycle_cases c ON c.org_id=i.org_id AND c.id=i.case_id WHERE i.org_id=l.org_id AND c.employee_id=l.employee_id AND i.filing_obligation_id=f.id AND c.state<>'CANCELLED' ORDER BY c.opened_at DESC LIMIT 1) AS lifecycle_case_id, \
      (SELECT w.name FROM workplace_revisions w WHERE w.org_id=l.org_id AND w.workplace_id=ea.workplace_id AND w.effective_from<=l.placement_date::date ORDER BY w.effective_from DESC,w.version DESC LIMIT 1) AS workplace_name, \
      COALESCE(receipt.version,0) AS version,CASE WHEN receipt.action='COMPLETE' THEN receipt.completed_on::text END AS completed_on, \
      receipt.receipt_number,receipt.loss_code,receipt.detail,receipt.action,receipt.not_applicable_reason,receipt.total_remuneration_won, \
      (SELECT r.action FROM insurance_filing_records r WHERE r.org_id=l.org_id AND (r.event_id=l.id OR r.request_id=l.id) AND r.insurer='EI' AND r.filing_kind=l.kind ORDER BY r.version DESC LIMIT 1) AS ei_action, \
      (SELECT min(r.anchor_on)::text FROM insurance_filing_requests r WHERE r.org_id=l.org_id AND r.source_event_id=l.id AND r.filing_kind='ACQUIRE_REQUESTED') AS requested_acquisition_on, \
      (SELECT max(h.effective_date::date)::text FROM employee_lifecycle_events h WHERE h.org_id=l.org_id AND h.employee_id=l.employee_id AND h.event_type IN ('ONBOARD','REHIRE','GROUP_TRANSFER') AND h.state='APPLIED' AND h.effective_date::date<=l.placement_date::date AND (l.source_type<>'GROUP_TRANSFER' OR l.kind NOT IN ('LOSE','SEPARATION_CERTIFICATE') OR h.effective_date::date<l.placement_date::date) AND NOT EXISTS(SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id=h.org_id AND v.voids_event_id=h.id AND v.state='APPLIED')) AS acquired_on, \
      (SELECT min(CASE WHEN h.event_type='GROUP_TRANSFER' THEN h.effective_date::date-1 ELSE h.effective_date::date END)::text FROM employee_lifecycle_events h WHERE h.org_id=l.org_id AND h.employee_id=l.employee_id AND h.event_type IN ('TERMINATE','OFFBOARD','GROUP_TRANSFER') AND h.state IN ('APPLIED','SCHEDULED') AND h.effective_date::date>l.source_on AND NOT EXISTS(SELECT 1 FROM employee_lifecycle_events v WHERE v.org_id=h.org_id AND v.voids_event_id=h.id AND v.state='APPLIED')) AS ended_on \
      FROM paged l CROSS JOIN LATERAL (SELECT l.kind AS k) kind CROSS JOIN LATERAL (SELECT l.insurer) agency",
    );
    if placement_filter {
        q.push(" CROSS JOIN LATERAL (SELECT l.legal_entity_id,l.workplace_id) ea ");
    } else {
        q.push(PLACEMENT);
    }
    q.push(FILING).push(
        " LEFT JOIN employee_personal_facts personal ON personal.org_id=l.org_id AND personal.employee_id=l.employee_id LEFT JOIN LATERAL (SELECT r.* FROM insurance_filing_records r WHERE r.org_id=l.org_id AND (r.event_id=l.id OR r.request_id=l.id) AND r.insurer=l.insurer AND r.filing_kind=l.kind ORDER BY r.version DESC LIMIT 1) receipt ON true \
      ), page_workplaces AS MATERIALIZED (SELECT DISTINCT workplace_id FROM hydrated WHERE workplace_id IS NOT NULL), \
      page_zones AS MATERIALIZED (SELECT w.id,lifecycle_time_zone(w.org_id,NULL,current_date,w.id) AS time_zone \
        FROM page_workplaces p JOIN workplaces w ON w.id=p.workplace_id AND w.org_id=(SELECT org_id FROM boundary) WHERE w.legal_entity_id IS NOT NULL), \
      zoned AS MATERIALIZED (SELECT paged.*,COALESCE(z.time_zone,lifecycle_time_zone((SELECT org_id FROM boundary),paged.employee_id,paged.placement_on,paged.workplace_id)) AS time_zone \
        FROM hydrated paged LEFT JOIN page_zones z ON z.id=paged.workplace_id) \
      SELECT zoned.*, (COALESCE(")
        .push_bind(query.inbox_as_of)
        .push(",now()) AT TIME ZONE time_zone)::date AS today, ((SELECT go_live_at FROM boundary) AT TIME ZONE time_zone)::date AS go_live_on FROM zoned")
        .push(order);
    Ok(q.build().fetch_all(tx.as_mut()).await?)
}

fn push_page_order(q: &mut QueryBuilder<Postgres>, query: &FilingQuery) -> &'static str {
    if let Some(limit) = query.inbox_scan_limit {
        if let Some((created_at, id)) = &query.inbox_after {
            q.push(" WHERE (created_at, inbox_id) > (")
                .push_bind(*created_at)
                .push(", ")
                .push_bind(id.clone())
                .push(")");
        }
        let order = " ORDER BY created_at, inbox_id";
        q.push(order)
            .push(" LIMIT ")
            .push_bind(i64::try_from(limit).unwrap_or(i64::MAX));
        order
    } else {
        let order = " ORDER BY effective_date,id,kind,insurer";
        q.push(order);
        order
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
