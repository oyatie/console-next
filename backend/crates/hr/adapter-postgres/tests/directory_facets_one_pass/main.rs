#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! PERF-BE (CAP-01): the one-pass facets and the lean page total return what
//! the five-pass facets and the full-FROM total returned, for every filter
//! combination and for a branch-scoped reader. The oracle (`oracle.rs`) is
//! the pre-rewrite algorithm over `filtered_employees` (the list's own FROM).

mod oracle;
#[path = "../support/mod.rs"]
mod support;
mod world;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::directory::read_facets::EmployeeFacets;
use console_hr_adapter_postgres::directory::read_filters::EmployeeListFilters;
use console_kernel_core::{BranchId, BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{query, tenant, user};

use oracle::{oracle, runtime, totals};
use world::{World, world};

fn filter_sets(w: &World) -> Vec<Value> {
    let statuses = [
        None,
        Some("ACTIVE"),
        Some("ACTIVE,ON_LEAVE"),
        Some("EXITED"),
    ];
    let entities = [None, Some(w.entities[0]), Some(w.entities[1])];
    let workplaces = [None, Some(w.workplaces[0])];
    let reviews = [
        json!({}),
        json!({ "identity_review_required": true }),
        json!({ "register_review_required": true }),
        json!({ "register_review_required": false }),
        json!({ "home_branch_review_required": true }),
        json!({ "home_branch_review_required": false, "identity_review_required": false }),
        json!({ "lifecycle_apply_failed": true }),
        json!({ "lifecycle_apply_failed": false }),
        json!({ "contract_ending_before": "2026-12-31" }),
    ];
    let mut out = Vec::new();
    for status in statuses {
        for entity in entities {
            for workplace in workplaces {
                for review in &reviews {
                    let mut q = review.clone();
                    if let Some(s) = status {
                        q["status"] = s.into();
                    }
                    if let Some(e) = entity {
                        q["legal_entity_id"] = e.to_string().into();
                    }
                    if let Some(p) = workplace {
                        q["workplace_id"] = p.to_string().into();
                    }
                    out.push(q);
                }
            }
        }
    }
    out.push(json!({ "search": "P1" }));
    out.push(json!({ "employee_number": "N-0,N-3,N-7", "status": "ACTIVE" }));
    out
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn one_pass_facets_and_lean_total_match_the_five_pass_reads(pool: PgPool) {
    let t = tenant(&pool).await;
    let actor = user(&pool, t.org, None).await;
    let w = world(&pool, t.org, actor).await;
    let rt = runtime(&pool).await;
    let readers = [
        (BranchScope::All, Role::SuperAdmin),
        (
            BranchScope::Branches(BTreeSet::from([BranchId::from_uuid(w.branch)])),
            Role::Admin,
        ),
    ];
    let mut checked = 0;
    for (scope, role) in readers {
        let principal = Principal::new(
            w.actor,
            OrgId::from_uuid(w.org),
            BTreeSet::from([role]),
            scope.clone(),
        );
        for q in filter_sets(&w) {
            let filters = EmployeeListFilters::from_query(&query(q.clone()), &scope).unwrap();
            let expected = oracle(&rt, w.org, filters.clone()).await;
            let got: EmployeeFacets =
                t.hr.employee_facets(principal.clone(), query(q.clone()))
                    .await
                    .unwrap();
            assert_eq!(
                serde_json::to_value(&got).unwrap(),
                expected,
                "facets for {q} ({scope:?})"
            );
            let (full, lean) = totals(&rt, w.org, filters).await;
            assert_eq!(full, lean, "total for {q} ({scope:?})");
            assert_eq!(got.total, full, "facet total = page total for {q}");
            checked += 1;
        }
    }
    assert!(checked > 300, "{checked}");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn facets_of_an_empty_tenant_are_zero(pool: PgPool) {
    let t = tenant(&pool).await;
    let actor = user(&pool, t.org, None).await;
    let principal = Principal::new(
        actor,
        OrgId::from_uuid(t.org),
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    let got =
        t.hr.employee_facets(
            principal,
            query(json!({ "contract_ending_before": "2026-12-31" })),
        )
        .await
        .unwrap();
    assert_eq!(
        serde_json::to_value(&got).unwrap(),
        json!({ "total": 0, "status": [], "employment_type": [], "legal_entity": [], "workplace": [],
                "review": { "register_review_required": 0, "identity_review_required": 0, "home_branch_review_required": 0,
                            "lifecycle_apply_failed": 0, "contract_ended": 0, "contract_ending_before": 0 } })
    );
}
