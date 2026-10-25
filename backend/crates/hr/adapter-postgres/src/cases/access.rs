// SPDX-License-Identifier: LicenseRef-Proprietary
use crate::{
    HrError,
    authz::{HrReach, Tier, hr_reach_in, push_reach},
};
use console_platform_authz::{Feature, Principal};
use sqlx::{Postgres, QueryBuilder, Transaction};
use uuid::Uuid;

/// A case retains the employer and unit of its event after the person moves.
pub(super) async fn may(
    tx: &mut Transaction<'_, Postgres>,
    p: &Principal,
    feature: Feature,
    case: Uuid,
) -> Result<bool, HrError> {
    let Ok(reach) = hr_reach_in(p, feature, Tier::Branch) else {
        return Ok(false);
    };
    if reach == HrReach::All {
        return Ok(true);
    }
    let mut q = QueryBuilder::<Postgres>::new(
        "SELECT EXISTS(SELECT 1 FROM lifecycle_cases c \
         LEFT JOIN employee_exit_cases x ON x.org_id=c.org_id AND x.id=c.exit_case_id \
         LEFT JOIN employee_lifecycle_events l ON l.org_id=c.org_id AND l.id=COALESCE(x.exit_lifecycle_event_id,c.trigger_id) \
         LEFT JOIN LATERAL (SELECT a.legal_entity_id,a.workplace_id FROM employment_assignments a \
           WHERE a.org_id=c.org_id AND a.employee_id=c.employee_id AND a.superseded_at IS NULL \
           AND a.valid_from<=c.effective_date AND (a.valid_to IS NULL OR c.effective_date<a.valid_to) ORDER BY a.valid_from DESC LIMIT 1) a ON true \
         LEFT JOIN workplaces w ON w.org_id=c.org_id AND w.id=COALESCE(c.workplace_id,a.workplace_id) \
         CROSS JOIN LATERAL (SELECT COALESCE(c.branch_id,w.default_branch_id) AS home_branch_id, \
           COALESCE(c.org_unit_id,CASE WHEN c.kind='EXIT' THEN l.from_org_unit_id ELSE COALESCE(l.to_org_unit_id,l.from_org_unit_id) END) AS org_unit_id) e \
         CROSS JOIN LATERAL (SELECT COALESCE(c.legal_entity_id,a.legal_entity_id) AS legal_entity_id,COALESCE(c.workplace_id,a.workplace_id) AS workplace_id) ea WHERE c.org_id=",
    );
    q.push_bind(*p.org_id.as_uuid())
        .push(" AND c.id=")
        .push_bind(case)
        .push(" AND ");
    push_reach(&mut q, &reach);
    q.push(")");
    Ok(q.build_query_scalar().fetch_one(tx.as_mut()).await?)
}
