// SPDX-License-Identifier: LicenseRef-Proprietary
//! Bulk admission uses the same live appointment permissions as a single event.
use http::StatusCode;
use sqlx::PgPool;

use crate::{BULK, DRIVER_TEST, jobs, lifecycle_grant, perf, settled, transfer, transfers};

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
