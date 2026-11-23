// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(dead_code, clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use console_compliance_adapter_postgres::rights::{DecideInput, PostponeInput};
use console_kernel_core::{OrgId, UserId};
use console_platform_auth::{MobileStepUpActionKind, PasskeyService};
use http::StatusCode;
use serde_json::Value;
use sqlx::PgPool;
use uuid::Uuid;

use super::period_unlock_support::{Admin, send, step_up_as};
use super::settings_support;

pub async fn grant_privacy_intake(pool: &PgPool, org: OrgId, grantor: UserId, handler: Uuid) {
    let grant = settings_support::seed_role_and_grant(
        pool,
        *org.as_uuid(),
        grantor,
        UserId::from_uuid(handler),
        "TENANT",
        None,
    )
    .await;
    for sql in [
        "INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE org_id=$1 AND version=1 AND role_id=(SELECT role_id FROM access_grants WHERE id=$2)",
        "INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'hr_basic',ARRAY['edit'] FROM access_grants WHERE id=$2",
        "UPDATE access_roles SET version=2 WHERE org_id=$1 AND id=(SELECT role_id FROM access_grants WHERE id=$2)",
    ] {
        sqlx::query(sql)
            .bind(org.as_uuid())
            .bind(grant)
            .execute(pool)
            .await
            .unwrap();
    }
}

pub async fn decide_with_step_up(
    pool: &PgPool,
    svc: &PasskeyService,
    service: &axum::Router,
    actor: &mut Admin,
    req_id: Uuid,
    input: Value,
) -> (StatusCode, Value) {
    let parsed: DecideInput = serde_json::from_value(input.clone()).unwrap();
    let payload = serde_json::to_string(&parsed).unwrap();
    let step_up = step_up_as(
        pool,
        svc,
        actor,
        MobileStepUpActionKind::PrivacyRequestDecide,
        req_id,
        &payload,
    )
    .await;
    let mut body = input;
    body["step_up"] = step_up;
    let uri = format!("/api/v1/privacy/rights-requests/{req_id}/decide");
    let key = Uuid::new_v4().to_string();
    send(service, &uri, &actor.token, Some(&key), body).await
}

pub async fn postpone_with_step_up(
    pool: &PgPool,
    svc: &PasskeyService,
    service: &axum::Router,
    actor: &mut Admin,
    req_id: Uuid,
    input: Value,
) -> (StatusCode, Value) {
    let parsed: PostponeInput = serde_json::from_value(input.clone()).unwrap();
    let payload = serde_json::to_string(&parsed).unwrap();
    let step_up = step_up_as(
        pool,
        svc,
        actor,
        MobileStepUpActionKind::PrivacyRequestDecide,
        req_id,
        &payload,
    )
    .await;
    let mut body = input;
    body["step_up"] = step_up;
    let uri = format!("/api/v1/privacy/rights-requests/{req_id}/postpone");
    let key = Uuid::new_v4().to_string();
    send(service, &uri, &actor.token, Some(&key), body).await
}
