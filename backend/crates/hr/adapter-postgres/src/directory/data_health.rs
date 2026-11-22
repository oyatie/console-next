// SPDX-License-Identifier: LicenseRef-Proprietary
//! People data-health aggregation endpoint (`GET /api/v1/hr/people/data-health`), reading via
//! `person_employees_current` with Cedar D1 visibility lowering and zero raw PII projection.

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use serde_json::json;
use sqlx::{Postgres, QueryBuilder, Row};
use uuid::Uuid;

pub use super::data_health_types::*;
use crate::authz::{Tier, hr_reach_in};
use crate::directory::access_log::{DirectoryAccess, access_event, actor_employee_id};
use crate::directory::read_filters::{EmployeeListFilters, EmployeeListQuery};
use crate::directory::read_from::push_facets_from;
use crate::rrn::record::directory;
use crate::{HrError, HrService};

const DEFAULT_DRILLDOWN_LIMIT: i64 = 20;
const MAX_DRILLDOWN_LIMIT: i64 = 50;

const ALLOWED_CATEGORIES: [&str; 14] = [
    "birth",
    "job",
    "hire",
    "contractEnd",
    "sex",
    "address",
    "career",
    "rrn_missing",
    "unplaced",
    "department_missing",
    "bank_account_missing",
    "identity_review",
    "failed_action",
    "register_incomplete",
];

fn push_scoped_cte(q: &mut QueryBuilder<Postgres>, filters: &EmployeeListFilters) {
    q.push(concat!(
        "WITH scoped AS ( \
           SELECT e.id, e.employee_number, \
                  entity_employment_status_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) AS live_status, \
                  e.id_type, ",
        crate::register_review_sql!(),
        " AS register_gap, ",
        crate::register_missing_fields_sql!(),
        " AS reg_missing, ",
        crate::identity_review_sql!(),
        " AS identity_gap, \
                  EXISTS (SELECT 1 FROM employee_rrn er WHERE er.org_id = e.org_id AND er.employee_id = e.id) AS rrn_recorded, \
                  (cp.employee_id IS NOT NULL) AS is_placed, \
                  (e.merged_into_employee_id IS NULL \
                    AND entity_employed_on(entity_today(), e.hire_on, e.exit_on, e.employment_status) \
                    AND (e.org_unit_id IS NULL OR e.org_unit_id NOT IN (SELECT department_unit_ids()))) AS no_department, \
                  COALESCE((SELECT epf.bank_account_registered FROM employee_personal_facts epf \
                    WHERE epf.org_id = e.org_id AND epf.employee_id = e.id), FALSE) AS bank_ok, \
                  (fe.id IS NOT NULL) AS has_failed",
    ));
    push_facets_from(q, filters);
    q.push(")");
}

impl HrService {
    /// Return tenant-scoped, branch- and Cedar-visible people data-health aggregates plus
    /// zero-PII drilldown items and `EmployeeDirectoryManage`-gated `latest_import`.
    pub async fn people_data_health(
        &self,
        principal: Principal,
        query: DataHealthQuery,
    ) -> Result<PeopleDataHealthResponse, HrError> {
        let category = query
            .category
            .as_deref()
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .map(str::to_owned);
        if let Some(cat) = category.as_deref()
            && !ALLOWED_CATEGORIES.contains(&cat)
        {
            return Err(HrError::validation(format!(
                "unknown data health category: {cat}"
            )));
        }
        let limit = query
            .limit
            .unwrap_or(DEFAULT_DRILLDOWN_LIMIT)
            .clamp(1, MAX_DRILLDOWN_LIMIT);

        let reach = hr_reach_in(&principal, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        let org = principal.org_id;
        let org_uuid = *org.as_uuid();
        let mut filters = EmployeeListFilters::from_query(
            &EmployeeListQuery::default(),
            &principal.branch_scope,
        )?
        .with_reach(reach);

        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                filters
                    .load_visibility(tx, &principal, Feature::EmployeeDirectoryRead)
                    .await?;
                let manages = directory(tx, &principal).await?;

                // Batch Query 1: single-pass cohort + statutory + id + placement + bank + review + failed.
                let mut agg = QueryBuilder::<Postgres>::new("");
                push_scoped_cte(&mut agg, &filters);
                agg.push(
                    " SELECT \
                        count(*)::BIGINT AS total, \
                        count(*) FILTER (WHERE live_status = 'ACTIVE')::BIGINT AS active, \
                        count(*) FILTER (WHERE live_status = 'ON_LEAVE')::BIGINT AS on_leave, \
                        count(*) FILTER (WHERE live_status = 'PRE_HIRE')::BIGINT AS pre_hire, \
                        count(*) FILTER (WHERE NOT register_gap)::BIGINT AS reg_complete, \
                        count(*) FILTER (WHERE register_gap)::BIGINT AS reg_incomplete, \
                        count(*) FILTER (WHERE 'birth' = ANY(reg_missing))::BIGINT AS miss_birth, \
                        count(*) FILTER (WHERE 'job' = ANY(reg_missing))::BIGINT AS miss_job, \
                        count(*) FILTER (WHERE 'hire' = ANY(reg_missing))::BIGINT AS miss_hire, \
                        count(*) FILTER (WHERE 'contractEnd' = ANY(reg_missing))::BIGINT AS miss_contract_end, \
                        count(*) FILTER (WHERE 'sex' = ANY(reg_missing))::BIGINT AS miss_sex, \
                        count(*) FILTER (WHERE 'address' = ANY(reg_missing))::BIGINT AS miss_address, \
                        count(*) FILTER (WHERE 'career' = ANY(reg_missing))::BIGINT AS miss_career, \
                        count(*) FILTER (WHERE rrn_recorded)::BIGINT AS rrn_recorded, \
                        count(*) FILTER (WHERE id_type = 'NOT_ISSUED')::BIGINT AS not_issued, \
                        count(*) FILTER (WHERE NOT rrn_recorded AND id_type IS DISTINCT FROM 'NOT_ISSUED')::BIGINT AS id_missing, \
                        count(*) FILTER (WHERE id_type = 'RRN')::BIGINT AS id_rrn, \
                        count(*) FILTER (WHERE id_type = 'ARC')::BIGINT AS id_arc, \
                        count(*) FILTER (WHERE id_type = 'DOMESTIC_RESIDENCE')::BIGINT AS id_dom, \
                        count(*) FILTER (WHERE id_type IS NULL)::BIGINT AS id_unset, \
                        count(*) FILTER (WHERE is_placed)::BIGINT AS placed, \
                        count(*) FILTER (WHERE NOT is_placed)::BIGINT AS unplaced, \
                        count(*) FILTER (WHERE no_department)::BIGINT AS dept_missing, \
                        count(*) FILTER (WHERE bank_ok)::BIGINT AS bank_registered, \
                        count(*) FILTER (WHERE NOT bank_ok)::BIGINT AS bank_missing, \
                        count(*) FILTER (WHERE identity_gap)::BIGINT AS identity_review, \
                        count(*) FILTER (WHERE has_failed)::BIGINT AS failed_actions \
                      FROM scoped WHERE live_status IN ('ACTIVE', 'ON_LEAVE', 'PRE_HIRE')",
                );
                let row = agg.build().fetch_one(tx.as_mut()).await?;

                // Batch Query 2: bounded zero-PII drilldown items.
                let mut drill = QueryBuilder::<Postgres>::new("");
                push_scoped_cte(&mut drill, &filters);
                drill.push(
                    ", flagged AS ( \
                       SELECT id, employee_number, live_status, register_gap, \
                              reg_missing || array_remove(ARRAY[ \
                                CASE WHEN NOT rrn_recorded AND id_type IS DISTINCT FROM 'NOT_ISSUED' THEN 'rrn_missing' END, \
                                CASE WHEN NOT is_placed THEN 'unplaced' END, \
                                CASE WHEN no_department THEN 'department_missing' END, \
                                CASE WHEN NOT bank_ok THEN 'bank_account_missing' END, \
                                CASE WHEN identity_gap THEN 'identity_review' END, \
                                CASE WHEN has_failed THEN 'failed_action' END \
                              ], NULL) AS missing_categories \
                       FROM scoped WHERE live_status IN ('ACTIVE', 'ON_LEAVE', 'PRE_HIRE') \
                     ) \
                     SELECT id, employee_number, live_status, missing_categories \
                     FROM flagged WHERE cardinality(missing_categories) > 0",
                );
                if let Some(cat) = category.as_deref() {
                    if cat == "register_incomplete" {
                        drill.push(" AND register_gap");
                    } else {
                        drill.push(" AND ");
                        drill.push_bind(cat.to_owned());
                        drill.push(" = ANY(missing_categories)");
                    }
                }
                drill.push(" ORDER BY cardinality(missing_categories) DESC, id ASC LIMIT ");
                drill.push_bind(limit);
                let drill_rows = drill.build().fetch_all(tx.as_mut()).await?;
                let mut drilldown_items = Vec::with_capacity(drill_rows.len());
                let mut subjects = Vec::with_capacity(drill_rows.len());
                for r in drill_rows {
                    let employee_id: Uuid = r.try_get("id")?;
                    subjects.push(employee_id);
                    drilldown_items.push(DataHealthDrilldownItem {
                        employee_id,
                        employee_number: r.try_get("employee_number")?,
                        employment_status: r.try_get("live_status")?,
                        missing_categories: r.try_get("missing_categories")?,
                    });
                }

                // Batch Query 3: latest import summary gated by EmployeeDirectoryManage.
                let latest_import = if manages {
                    let imp = sqlx::query(
                        "SELECT id, status, candidate_rows, created_at, applied_at \
                         FROM data_import_runs \
                         WHERE org_id = $1 AND entity_type = 'employee_hr' \
                         ORDER BY created_at DESC LIMIT 1",
                    )
                    .bind(org_uuid)
                    .fetch_optional(tx.as_mut())
                    .await?;
                    imp.map(|r| -> Result<LatestImportRunHealth, sqlx::Error> {
                        Ok(LatestImportRunHealth {
                            run_id: r.try_get("id")?,
                            status: r.try_get("status")?,
                            candidate_rows: r.try_get("candidate_rows")?,
                            created_at: r.try_get("created_at")?,
                            applied_at: r.try_get("applied_at")?,
                        })
                    })
                    .transpose()?
                } else {
                    None
                };

                let me = actor_employee_id(tx, &principal).await?;
                let event = access_event(
                    &principal,
                    DirectoryAccess::List,
                    &subjects,
                    me,
                    json!({ "surface": "data_health" }),
                )?;
                let response = PeopleDataHealthResponse {
                    cohort: DataHealthCohort {
                        total: row.try_get("total")?,
                        active: row.try_get("active")?,
                        on_leave: row.try_get("on_leave")?,
                        pre_hire: row.try_get("pre_hire")?,
                    },
                    statutory_register: StatutoryRegisterHealth {
                        complete_count: row.try_get("reg_complete")?,
                        incomplete_count: row.try_get("reg_incomplete")?,
                        missing_by_category: RegisterCategoryMissing {
                            birth: row.try_get("miss_birth")?,
                            job: row.try_get("miss_job")?,
                            hire: row.try_get("miss_hire")?,
                            contract_end: row.try_get("miss_contract_end")?,
                            sex: row.try_get("miss_sex")?,
                            address: row.try_get("miss_address")?,
                            career: row.try_get("miss_career")?,
                        },
                    },
                    id_summary: IdHealthSummary {
                        rrn_recorded: row.try_get("rrn_recorded")?,
                        not_issued: row.try_get("not_issued")?,
                        missing: row.try_get("id_missing")?,
                        by_type: IdTypeBreakdown {
                            rrn: row.try_get("id_rrn")?,
                            arc: row.try_get("id_arc")?,
                            domestic_residence: row.try_get("id_dom")?,
                            not_issued: row.try_get("not_issued")?,
                            unset: row.try_get("id_unset")?,
                        },
                    },
                    placement_summary: PlacementHealthSummary {
                        placed: row.try_get("placed")?,
                        unplaced: row.try_get("unplaced")?,
                        department_missing: row.try_get("dept_missing")?,
                    },
                    bank_account: BankAccountHealth {
                        registered: row.try_get("bank_registered")?,
                        missing: row.try_get("bank_missing")?,
                    },
                    identity_review: IdentityReviewHealth {
                        needs_review: row.try_get("identity_review")?,
                    },
                    failed_actions: FailedActionsHealth {
                        count: row.try_get("failed_actions")?,
                    },
                    drilldown_items,
                    latest_import,
                };
                Ok((response, vec![event]))
            })
        })
        .await
    }
}
