// SPDX-License-Identifier: LicenseRef-Proprietary
use super::Read;
use sqlx::{Postgres, QueryBuilder};

pub(super) fn push(q: &mut QueryBuilder<Postgres>, mode: &Read<'_>) {
    match mode {
        Read::Selected(ids) => {
            q.push("selected_sources AS (SELECT split_part(key, ':', 2)::uuid AS id FROM unnest(")
                .push_bind(*ids)
                .push("::text[]) keys(key)), ");
        }
        Read::Birthdays(people) => {
            q.push("probed_people AS (SELECT unnest(")
                .push_bind(*people)
                .push("::uuid[]) AS id), ");
        }
        _ => {}
    }
    q.push("presence AS MATERIALIZED (SELECT \
           EXISTS(SELECT 1 FROM insurance_filing_records WHERE org_id=(SELECT org_id FROM boundary)) AS receipts, \
           EXISTS(SELECT 1 FROM insurance_filing_requests WHERE org_id=(SELECT org_id FROM boundary)) AS requests, \
           EXISTS(SELECT 1 FROM employee_lifecycle_events WHERE org_id=(SELECT org_id FROM boundary) AND event_type IN ('TERMINATE','OFFBOARD','GROUP_TRANSFER') AND state IN ('APPLIED','SCHEDULED')) AS exits), ");
    q.push("sources AS (SELECT id,org_id,employee_id,event_type,state,effective_date,created_at,from_org_unit_id,to_org_unit_id,to_workplace_id,NULL::text AS request_kind,NULL::uuid AS source_event_id,effective_date AS placement_date,event_type AS source_type,id AS voidable_event_id FROM employee_lifecycle_events WHERE org_id=(SELECT org_id FROM boundary)");
    q.push(match mode {
        Read::Selected(_) => " AND id IN (SELECT id FROM selected_sources)",
        Read::Birthdays(_) => " AND employee_id IN (SELECT id FROM probed_people)",
        _ => "",
    });
    q.push(" UNION ALL SELECT r.id,r.org_id,r.employee_id,'STATUTORY_REQUEST',p.state,r.anchor_on::text,r.created_at,p.from_org_unit_id,p.to_org_unit_id,p.to_workplace_id,r.filing_kind,r.source_event_id,p.effective_date,p.event_type,r.source_event_id FROM insurance_filing_requests r JOIN employee_lifecycle_events p ON p.org_id=r.org_id AND p.id=r.source_event_id WHERE r.filing_kind<>'ACQUIRE_REQUESTED' AND r.org_id=(SELECT org_id FROM boundary)");
    q.push(match mode {
        Read::Selected(_) => " AND r.id IN (SELECT id FROM selected_sources)",
        Read::Birthdays(_) => " AND r.employee_id IN (SELECT id FROM probed_people)",
        _ => "",
    });
    q.push("), age_facts AS MATERIALIZED (SELECT DISTINCT ON (COALESCE(event_id,request_id),insurer,filing_kind) COALESCE(event_id,request_id) AS source_id,insurer,filing_kind,applicability_facts \
           FROM insurance_filing_records WHERE org_id=(SELECT org_id FROM boundary) AND filing_kind='AGE60' AND applicability_facts IS NOT NULL");
    if matches!(mode, Read::Selected(_) | Read::Birthdays(_)) {
        q.push(" AND COALESCE(event_id,request_id) IN (SELECT id FROM sources)");
    }
    q.push(" ORDER BY COALESCE(event_id,request_id),insurer,filing_kind,version DESC), ");
}
