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
use std::time::{Duration, Instant};

use console_hr_adapter_postgres::directory::read_facets::EmployeeFacets;
use console_hr_adapter_postgres::directory::read_filters::EmployeeListFilters;
use console_kernel_core::{BranchId, BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use serde_json::{Value, json};
use sqlx::PgPool;
use support::{query, tenant, user};

use oracle::{oracle, runtime, totals};
use world::{World, place_except_last, seed, world, world_count};

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

async fn assert_placement_gaps(t: &support::Tenant, w: &World, missing: &[uuid::Uuid]) {
    let principal = support::principal(w.org, w.actor);
    let facets =
        t.hr.employee_facets(principal.clone(), query(json!({})))
            .await
            .unwrap();
    assert_eq!(facets.total, i64::try_from(w.people.len()).unwrap());
    assert_eq!(
        facets.review.home_branch_review_required,
        i64::try_from(missing.len()).unwrap()
    );
    let listed =
        t.hr.list_employees(
            principal.clone(),
            query(json!({ "home_branch_review_required": true })),
        )
        .await
        .unwrap();
    let expected = missing.iter().copied().collect::<BTreeSet<_>>();
    assert_eq!(listed.total, i64::try_from(missing.len()).unwrap());
    assert_eq!(
        listed.items.iter().map(|p| p.id).collect::<BTreeSet<_>>(),
        expected
    );
    assert!(listed.items.iter().all(|p| p.home_branch_review_required));
    let placed =
        t.hr.list_employees(
            principal.clone(),
            query(json!({ "home_branch_review_required": false })),
        )
        .await
        .unwrap();
    assert_eq!(
        placed.total,
        i64::try_from(w.people.len() - missing.len()).unwrap()
    );
    assert!(placed.items.iter().all(|p| !p.home_branch_review_required));
    let unplaced =
        t.hr.import_unplaced(principal, Default::default())
            .await
            .unwrap();
    assert_eq!(unplaced.count, i64::try_from(missing.len()).unwrap());
    assert_eq!(
        unplaced
            .items
            .iter()
            .map(|p| p.employee_id)
            .collect::<BTreeSet<_>>(),
        expected
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn placement_review_ignores_null_routing_copies_for_placed_people(pool: PgPool) {
    let t = tenant(&pool).await;
    let actor = user(&pool, t.org, None).await;
    let w = world_count(&pool, t.org, actor, 4).await;
    place_except_last(&pool, &w).await;
    assert_placement_gaps(&t, &w, &w.people[3..]).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn placement_review_rejects_future_expired_superseded_and_missing_workplaces(pool: PgPool) {
    let t = tenant(&pool).await;
    let actor = user(&pool, t.org, None).await;
    let w = world_count(&pool, t.org, actor, 6).await;
    place_except_last(&pool, &w).await;
    seed(&pool, format!(
        "UPDATE employees SET home_branch_id='{}' WHERE org_id='{}'; \
         UPDATE employment_assignments SET valid_from=entity_today()+1 WHERE employee_id='{}'; \
         UPDATE employment_assignments SET valid_from=entity_today()-2,valid_to=entity_today() WHERE employee_id='{}'; \
         UPDATE employment_assignments SET superseded_at=now() WHERE employee_id='{}'; \
         UPDATE employment_assignments SET workplace_id=NULL WHERE employee_id='{}';",
        w.branch, w.org, w.people[1], w.people[2], w.people[3], w.people[4]
    )).await;
    assert_placement_gaps(&t, &w, &w.people[1..]).await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn placement_review_at_two_thousand_people_stays_within_the_api_budget(pool: PgPool) {
    let t = tenant(&pool).await;
    let actor = user(&pool, t.org, None).await;
    let w = world_count(&pool, t.org, actor, 2_000).await;
    place_except_last(&pool, &w).await;
    let principal = support::principal(w.org, w.actor);
    for _ in 0..4 {
        t.hr.employee_facets(principal.clone(), query(json!({})))
            .await
            .unwrap();
    }
    let mut samples = Vec::new();
    let mut review_counts = BTreeSet::new();
    for _ in 0..20 {
        let started = Instant::now();
        let facets =
            t.hr.employee_facets(principal.clone(), query(json!({})))
                .await
                .unwrap();
        samples.push(started.elapsed());
        review_counts.insert(facets.review.home_branch_review_required);
    }
    samples.sort_unstable();
    let p95 = samples[18];
    // The API SLO owns the available latency bound; no per-roster SLO exists yet.
    let seconds: f64 = include_str!("../../../../../app/slos/api-latency.openslo.yaml")
        .lines()
        .find_map(|line| line.trim().strip_prefix("value: "))
        .unwrap()
        .parse()
        .unwrap();
    let budget = Duration::from_secs_f64(seconds);
    eprintln!(
        "placement facets: people=2000 samples=20 p95={p95:?} API budget={budget:?} role=console_rt"
    );
    assert_eq!(review_counts, BTreeSet::from([1]));
    assert!(
        p95 <= budget,
        "facet p95 {p95:?} exceeds the API SLO {budget:?}"
    );
    assert_placement_gaps(&t, &w, &w.people[1_999..]).await;
}
