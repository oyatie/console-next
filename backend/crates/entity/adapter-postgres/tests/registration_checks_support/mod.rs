// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#![allow(dead_code)]
use crate::common;
use console_entity_adapter_postgres::{CheckSchedulePolicy, PgEntityStore};
use console_entity_application::{
    Actor,
    registration_check::{CheckAnswer, FakeRegistrationCheck},
};
use console_entity_domain::codes::OperatingStatus;
use serde_json::Value;
use sqlx::PgPool;
use std::sync::Arc;
use uuid::Uuid;
pub(super) const BRN: &str = "0008100009";
pub(super) fn fake(code: &str) -> Arc<FakeRegistrationCheck> {
    let mut answer = CheckAnswer::status(BRN, code);
    answer.reported_status = match code {
        "01" => Some(OperatingStatus::Continuing),
        "02" => Some(OperatingStatus::Suspended),
        "03" => Some(OperatingStatus::Closed),
        _ => None,
    };
    answer.response_sha256 = "a".repeat(64);
    if code == "03" {
        answer.end_dt = Some("20260930".into());
    }
    Arc::new(FakeRegistrationCheck::configured(vec![answer]))
}
pub(super) async fn subject(pool: &PgPool, opened: Option<String>) -> (PgEntityStore, Actor, Uuid) {
    let (store, actor) = common::tenant(pool, Uuid::new_v4(), "nts").await;
    let e = store
        .create_entity(
            &common::cmd(&actor),
            common::corporation("조회 법인", "0002119999918"),
        )
        .await
        .unwrap()
        .record;
    let mut input = common::certificate(BRN);
    if let Some(opened) = opened {
        input.opened_on = Some(opened);
    }
    let r = store
        .create_registration(&common::cmd(&actor), e.id, input)
        .await
        .unwrap()
        .record;
    (store, actor, r.id)
}
pub(super) async fn evidence(pool: &PgPool, id: Uuid) -> Value {
    sqlx::query_scalar("SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM business_registration_checks c WHERE registration_id=$1").bind(id).fetch_one(pool).await.unwrap()
}
pub(super) async fn due(pool: &PgPool, id: Uuid) {
    sqlx::query("UPDATE business_registration_check_schedule SET due_at=now()-interval '1 second' WHERE registration_id=$1").bind(id).execute(pool).await.unwrap();
}

pub(super) async fn tick(
    owner: &PgPool,
    store: &PgEntityStore,
    actor: &Actor,
    status: &str,
    policy: CheckSchedulePolicy,
) -> usize {
    set_policy(owner, policy).await;
    store
        .check_due_registrations(actor.org, fake(status))
        .await
        .unwrap()
}

pub(super) async fn set_policy(pool: &PgPool, policy: CheckSchedulePolicy) {
    for (key, value) in [
        ("nts.check.cadence_hours", policy.cadence_hours),
        ("nts.check.batch_size", policy.batch_size),
        ("nts.check.daily_budget", policy.daily_budget),
        ("nts.check.backoff_seconds", policy.backoff_seconds),
    ] {
        sqlx::query(
            "INSERT INTO platform_setting_overrides(key,value) VALUES($1,to_jsonb($2::bigint))",
        )
        .bind(key)
        .bind(value)
        .execute(pool)
        .await
        .unwrap();
    }
}
