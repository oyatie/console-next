// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::collections::BTreeSet;

use axum::{
    Extension,
    body::{Body, to_bytes},
    http::{Request, StatusCode},
};
use console_hr_adapter_postgres::HrService;
use console_hr_rest::person_binding::{REVIEWS_PATH, router};
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::{Principal, Role};
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use sqlx::PgPool;
use tower::ServiceExt;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn only_tenant_wide_hr_reads_its_own_binding_evidence(pool: PgPool) {
    let org = OrgId::from_uuid(uuid::Uuid::new_v4());
    let foreign = OrgId::from_uuid(uuid::Uuid::new_v4());
    let user = seed_org_and_super_admin(&pool, *org.as_uuid(), "binding-api").await;
    seed_org_and_super_admin(&pool, *foreign.as_uuid(), "foreign-binding-api").await;
    for tenant in [org, foreign] {
        sqlx::query("INSERT INTO person_binding_reviews(org_id,subject_kind,subject_id,reason,evidence) VALUES($1,'ACCOUNT',$2,'EMPLOYEE_LINK_MISSING','{\"candidates\":[]}'::jsonb)")
            .bind(tenant.as_uuid()).bind(user.as_uuid()).execute(&pool).await.unwrap();
    }
    let hr = HrService::new(runtime_role_pool(&pool).await);
    for (roles, scope, want) in [
        (
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
            StatusCode::OK,
        ),
        (
            BTreeSet::from([Role::Member]),
            BranchScope::All,
            StatusCode::FORBIDDEN,
        ),
        (
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::Branches(BTreeSet::new()),
            StatusCode::FORBIDDEN,
        ),
    ] {
        let principal = Principal::new(user, org, roles, scope);
        let response = router(hr.clone())
            .layer(Extension(principal))
            .oneshot(
                Request::builder()
                    .uri(format!("{REVIEWS_PATH}?limit=1&offset=0"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), want);
        if want == StatusCode::OK {
            let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
            let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
            assert_eq!(
                json["total"], 1,
                "RLS excludes foreign review names and counts"
            );
            assert_eq!(json["items"].as_array().unwrap().len(), 1);
            assert_eq!(json["items"][0]["subject_id"], user.to_string());
        }
    }
    let reads: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_events WHERE org_id=$1 AND action='person_binding_reviews.read'")
        .bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
    assert_eq!(reads, 1);
}
