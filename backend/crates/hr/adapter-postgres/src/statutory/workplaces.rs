//! Picker metadata uses the same HR reach; it does not require organization-management grants.
use crate::{
    HrError, HrService,
    authz::{Tier, hr_reach_in, push_reach},
    clock::today_kst,
};
use console_hr_domain::text::parse_yyyy_mm_dd;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use sqlx::{Postgres, QueryBuilder};
use uuid::Uuid;

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct RegisterWorkplace {
    pub id: Uuid,
    pub name: String,
    pub entity_name: Option<String>,
}

impl HrService {
    pub async fn statutory_workplaces(
        &self,
        p: Principal,
        as_of: Option<String>,
    ) -> Result<Vec<RegisterWorkplace>, HrError> {
        let reach = hr_reach_in(&p, Feature::EmployeeDirectoryManage, Tier::Branch)?;
        let on = as_of
            .map(|s| parse_yyyy_mm_dd(&s))
            .transpose()?
            .unwrap_or_else(today_kst);
        if on > today_kst() {
            return Err(HrError::validation("as_of cannot be later than today"));
        }
        with_org_conn(&self.pool,p.org_id,move |tx| Box::pin(async move {
            let mut q=QueryBuilder::<Postgres>::new("WITH point AS (SELECT ");
            q.push_bind(on).push("::date AS on_date) SELECT DISTINCT w.id, wr.name, lr.name AS entity_name, le.sort_order AS e_order, le.created_at AS e_created, le.id AS e_id, w.sort_order, w.created_at FROM workplaces w \
                LEFT JOIN legal_entities le ON le.org_id=w.org_id AND le.id=w.legal_entity_id \
                JOIN LATERAL (SELECT name FROM workplace_revisions r WHERE r.org_id=w.org_id AND r.workplace_id=w.id AND r.effective_from<=(SELECT on_date FROM point) ORDER BY r.effective_from DESC,r.version DESC LIMIT 1) wr ON TRUE \
                LEFT JOIN LATERAL (SELECT name FROM legal_entity_revisions r WHERE r.org_id=w.org_id AND r.legal_entity_id=w.legal_entity_id AND r.effective_from<=(SELECT on_date FROM point) ORDER BY r.effective_from DESC,r.version DESC LIMIT 1) lr ON TRUE \
                CROSS JOIN LATERAL (SELECT w.legal_entity_id, w.id AS workplace_id) ea \
                CROSS JOIN LATERAL (SELECT u.org_unit_id, NULL::uuid AS home_branch_id FROM org_unit_placements u WHERE u.org_id=w.org_id AND u.workplace_id=w.id AND u.valid_from<=(SELECT on_date FROM point) AND (u.valid_to IS NULL OR u.valid_to>(SELECT on_date FROM point)) UNION SELECT NULL::uuid,NULL::uuid) e \
                WHERE w.org_id=").push_bind(*p.org_id.as_uuid()).push(" AND ");
            push_reach(&mut q,&reach);
            // The stored order, as the chart and every other 법인/사업장 list show it.
            q.push(" ORDER BY e_order NULLS LAST, e_created, e_id, w.sort_order NULLS LAST, w.created_at, w.id");
            Ok(q.build_query_as().fetch_all(tx.as_mut()).await?)
        })).await
    }
}
