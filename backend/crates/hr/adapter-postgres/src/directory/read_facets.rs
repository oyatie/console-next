//! `GET /employees/facets`: the roster chip counts in one read (HR design §10
//! A2), over the same filtered rows as the list, so a count never includes a
//! row the caller could not list (PEOPLE-B).

use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use serde::Serialize;
use sqlx::{Postgres, QueryBuilder, Row};

use crate::authz::{Tier, hr_reach_in};
use crate::clock::today_kst;
use crate::directory::read_filters::{
    EmployeeListFilters, EmployeeListQuery, FacetGroup, push_facets_from,
};
use crate::metrics::record_hr_read;
use crate::{HrError, HrService};

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct FacetCount {
    /// The value counted; null for rows that have none (no employment profile).
    pub value: Option<String>,
    pub count: i64,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct EmployeeReviewCounts {
    pub identity_review_required: i64,
    pub register_review_required: i64,
    pub home_branch_review_required: i64,
    pub lifecycle_apply_failed: i64,
    /// Current contract ended before today (KST).
    pub contract_ended: i64,
    /// Current contract ends before the request's `contract_ending_before`;
    /// null when the request named no date.
    pub contract_ending_before: Option<i64>,
}

/// Each group is counted with every filter except its own, as the chips
/// combine: `status` ignores the status filter; `review` ignores the review
/// and contract filters (one count per flag); `legal_entity` / `workplace`
/// ignore their own id filter (the 법인 / 사업장 switcher); `total` and
/// `employment_type` apply every filter.
#[derive(Debug, Serialize)]
pub struct EmployeeFacets {
    pub total: i64,
    pub status: Vec<FacetCount>,
    pub employment_type: Vec<FacetCount>,
    /// Counts per `legal_entity_id` (E-S3a); null value: no assignment yet.
    pub legal_entity: Vec<FacetCount>,
    /// Counts per `workplace_id` (E-S3a); null value: no 사업장 recorded.
    pub workplace: Vec<FacetCount>,
    pub review: EmployeeReviewCounts,
}

impl HrService {
    pub async fn employee_facets(
        &self,
        principal: Principal,
        query: EmployeeListQuery,
    ) -> Result<EmployeeFacets, HrError> {
        let reach = hr_reach_in(&principal, Feature::EmployeeDirectoryRead, Tier::Branch)?;
        record_hr_read("employee_facets");
        let filters =
            EmployeeListFilters::from_query(&query, &principal.branch_scope)?.with_reach(reach);
        let window = filters.contract_ending_before;
        let today = today_kst();

        // CAP-01: one scan instead of five. `f` carries each row's group
        // values and whether it passes each group's own filters; every count is
        // `count(*) FILTER` over the groups it keeps, per grouping set.
        let mut query = QueryBuilder::<Postgres>::new(
            "WITH f AS (SELECT e.employment_status AS status, p.employment_type AS etype, \
             ea.legal_entity_id, ea.workplace_id, e.identity_review_required AS identity, \
             b.id IS NULL AS no_branch, fe.id IS NOT NULL AS failed, \
             p.contract_end_date AS contract_end, ",
        );
        query.push(crate::register_review_sql!());
        query.push(" AS register_gap, ");
        for (group, alias) in [
            (FacetGroup::Status, " AS s, "),
            (FacetGroup::LegalEntity, " AS en, "),
            (FacetGroup::Workplace, " AS w, "),
            (FacetGroup::Review, " AS r"),
        ] {
            filters.push_group(group, &mut query);
            query.push(alias);
        }
        push_facets_from(&mut query, &filters);
        query.push(
            ") SELECT status, etype, legal_entity_id::text AS entity, \
             workplace_id::text AS workplace, \
             GROUPING(status, etype, legal_entity_id, workplace_id) AS g, \
             count(*) FILTER (WHERE s AND en AND w AND r) AS n_all, \
             count(*) FILTER (WHERE en AND w AND r) AS n_status, \
             count(*) FILTER (WHERE s AND w AND r) AS n_entity, \
             count(*) FILTER (WHERE s AND en AND r) AS n_workplace, \
             count(*) FILTER (WHERE s AND en AND w AND register_gap) AS register_gap, \
             count(*) FILTER (WHERE s AND en AND w AND identity) AS identity, \
             count(*) FILTER (WHERE s AND en AND w AND no_branch) AS branch, \
             count(*) FILTER (WHERE s AND en AND w AND failed) AS failed, \
             count(*) FILTER (WHERE s AND en AND w AND contract_end < ",
        );
        query.push_bind(today);
        query.push(") AS ended, count(*) FILTER (WHERE s AND en AND w AND contract_end < ");
        query.push_bind(window);
        query.push(
            ") AS ending FROM f \
             GROUP BY GROUPING SETS ((status), (etype), (legal_entity_id), (workplace_id), ()) \
             ORDER BY g, status NULLS LAST, etype NULLS LAST, entity NULLS LAST, \
             workplace NULLS LAST",
        );

        let rows = with_org_conn::<_, _, HrError>(&self.pool, principal.org_id, move |tx| {
            Box::pin(async move { Ok(query.build().fetch_all(tx.as_mut()).await?) })
        })
        .await?;
        let mut facets = EmployeeFacets {
            total: 0,
            status: Vec::new(),
            employment_type: Vec::new(),
            legal_entity: Vec::new(),
            workplace: Vec::new(),
            review: EmployeeReviewCounts {
                identity_review_required: 0,
                register_review_required: 0,
                home_branch_review_required: 0,
                lifecycle_apply_failed: 0,
                contract_ended: 0,
                contract_ending_before: window.map(|_| 0),
            },
        };
        for row in rows {
            // GROUPING(): a bit per argument, set when that column is rolled up.
            let (list, value, count) = match row.try_get::<i32, _>("g")? {
                0b0111 => (&mut facets.status, "status", "n_status"),
                0b1011 => (&mut facets.employment_type, "etype", "n_all"),
                0b1101 => (&mut facets.legal_entity, "entity", "n_entity"),
                0b1110 => (&mut facets.workplace, "workplace", "n_workplace"),
                _ => {
                    facets.total = row.try_get("n_all")?;
                    facets.review = EmployeeReviewCounts {
                        identity_review_required: row.try_get("identity")?,
                        register_review_required: row.try_get("register_gap")?,
                        home_branch_review_required: row.try_get("branch")?,
                        lifecycle_apply_failed: row.try_get("failed")?,
                        contract_ended: row.try_get("ended")?,
                        contract_ending_before: window
                            .map(|_| row.try_get("ending"))
                            .transpose()?,
                    };
                    continue;
                }
            };
            let count: i64 = row.try_get(count)?;
            if count > 0 {
                list.push(FacetCount {
                    value: row.try_get(value)?,
                    count,
                });
            }
        }
        Ok(facets)
    }
}
