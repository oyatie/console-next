// SPDX-License-Identifier: LicenseRef-Proprietary
//! Bulk admission uses the same live appointment permissions as a single event.
use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::lifecycle::events_page::LifecycleEventsQuery;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use http::StatusCode;
use sqlx::PgPool;
use std::collections::BTreeSet;
use tracing::instrument::WithSubscriber;

use crate::{
    BULK, DRIVER_TEST, jobs, lifecycle_grant, perf, settled, trail_queries, transfer, transfers,
};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn lifecycle_access_checks_do_not_load_the_org_tree(pool: PgPool) {
    // Ensure tracing-core's sqlx::query DEBUG callsite finishes one-time registration
    // before counting statements alongside concurrent database tests in this binary.
    loop {
        let warmup = trail_queries::Queries::default();
        sqlx::query("SELECT 1")
            .execute(&pool)
            .with_subscriber(tracing::Dispatch::new(warmup.clone()))
            .await
            .unwrap();
        if !warmup.statements().is_empty() {
            break;
        }
    }
    let mut counts = Vec::new();
    for units in [1, 20] {
        let (_, org, admin) = perf::setup(&pool).await;
        lifecycle_grant::grant_hr_basic(&pool, org, *admin.as_uuid(), &["view", "edit"]).await;
        let employee = perf::seed_employee(&pool, org, "권한 확인").await;
        for index in 0..units {
            perf::seed_org_unit(&pool, org, admin, &format!("추가부서 {index}")).await;
        }
        let rt =
            perf::sized_role_pool(&pool, "console_rt", 1, std::time::Duration::from_secs(30)).await;
        let service = HrService::new(rt);
        let principal = Principal::new(
            admin,
            OrgId::from_uuid(org),
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let queries = trail_queries::Queries::default();
        let dispatch = tracing::Dispatch::new(queries.clone());
        async {
            service
                .check_bulk_lifecycle_access(&principal)
                .await
                .unwrap();
            service
                .employee_fixed_term(principal.clone(), employee)
                .await
                .unwrap();
            service
                .lifecycle_events(principal, employee, LifecycleEventsQuery::default(), false)
                .await
                .unwrap();
        }
        .with_subscriber(dispatch)
        .await;
        let statements = queries.statements();
        assert!(
            !statements.is_empty(),
            "SQL observer must record lifecycle access checks"
        );
        assert!(
            statements.iter().all(
                |statement| !statement.contains("SELECT id FROM legal_entities")
                    && !statement.contains("SELECT id, legal_entity_id FROM workplaces")
                    && !statement.contains("WITH RECURSIVE heads AS")
            ),
            "a lifecycle access check loaded the org tree: {statements:#?}"
        );
        counts.push(statements.len());
    }
    assert_eq!(
        counts,
        vec![counts[0]; 2],
        "lifecycle access SQL count must stay flat at 1 and 20 org units"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_access_is_decided_before_the_idempotency_key(pool: PgPool) {
    let (ctx, org, admin) = perf::setup(&pool).await;
    let person = perf::seed_employee(&pool, org, "일괄 1").await;
    let unit = perf::seed_org_unit(&pool, org, admin, "정비2팀").await;
    for prefer_async in [false, true] {
        for key in [None, Some("bulk-access-valid-key-001")] {
            let (status, _, body) = ctx
                .send(
                    "POST",
                    BULK,
                    &ctx.roleless,
                    key,
                    prefer_async,
                    Some(transfer(&[person], unit)),
                )
                .await;
            assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
            assert_eq!(body["error"]["code"], "forbidden", "{body}");
        }
    }
    assert_eq!(
        (jobs(&pool, org).await, transfers(&pool, org).await),
        (0, 0)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn hr_basic_edit_admits_bulk_preview_sync_async_and_job_read(pool: PgPool) {
    let _drivers = DRIVER_TEST.lock().await;
    let (ctx, org, admin) = perf::setup(&pool).await;
    lifecycle_grant::grant_hr_basic(&pool, org, *admin.as_uuid(), &["edit"]).await;
    let unit = perf::seed_org_unit(&pool, org, admin, "정비2팀").await;
    for prefer_async in [false, true] {
        let person = perf::seed_employee(&pool, org, "일괄 1").await;
        let request = transfer(&[person], unit);
        let (status, _, preview) = ctx
            .send(
                "POST",
                &format!("{BULK}/preview"),
                &ctx.token,
                None,
                false,
                Some(request.clone()),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{preview}");
        let (status, headers, result) = ctx
            .send(
                "POST",
                BULK,
                &ctx.token,
                Some(if prefer_async {
                    "hr-basic-bulk-async-001"
                } else {
                    "hr-basic-bulk-sync-001"
                }),
                prefer_async,
                Some(request),
            )
            .await;
        if prefer_async {
            assert_eq!(status, StatusCode::ACCEPTED, "{result}");
            let location = headers.get("location").unwrap().to_str().unwrap();
            let done = settled(&ctx, &ctx.token, location).await;
            assert_eq!(done["state"], "done", "{done}");
        } else {
            assert_eq!(status, StatusCode::OK, "{result}");
        }
    }
    assert_eq!(
        (jobs(&pool, org).await, transfers(&pool, org).await),
        (1, 2)
    );
}
