//! Fixtures shared by the BW-29 second-person fact tests.
#![allow(dead_code)]

pub mod access;

use console_identity_adapter_postgres::second_person::{
    SecondPersonFact, SecondPersonQuery, second_person_fact_in_tx,
};
use console_kernel_core::{OrgId, UserId};
use console_platform_authz::Feature;
use sqlx::PgPool;
use time::OffsetDateTime;
use uuid::Uuid;

pub static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("../../platform/db/migrations");

pub const MIN_GRANT_AGE_DAYS: i32 = 7;

pub fn org() -> Uuid {
    *OrgId::one().as_uuid()
}

/// Insert a user as `actor` (the `app.current_actor` GUC), optionally linked
/// to an employee, then age its ledger rows and record the notice.
pub async fn holder(
    owner: &PgPool,
    actor: Option<Uuid>,
    roles: &[&str],
    employee: bool,
    age_days: i32,
    notified: bool,
) -> Uuid {
    let mut tx = owner.begin().await.unwrap();
    if let Some(actor) = actor {
        sqlx::query("SELECT set_config('app.current_actor', $1, true)")
            .bind(actor.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
    }
    let user: Uuid = sqlx::query_scalar(
        "INSERT INTO users (display_name, roles, org_id) VALUES ('Holder', $1, $2) RETURNING id",
    )
    .bind(roles)
    .bind(org())
    .fetch_one(tx.as_mut())
    .await
    .unwrap();
    if employee {
        let id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO employees (id, org_id, company, name, employee_number, source_filename, source_sheet, source_row, source_key) \
             VALUES ($1, $2, 'Test Company', 'Holder', $3, 'test.csv', 'employees', 1, $4)",
        )
        .bind(id)
        .bind(org())
        .bind(id.simple().to_string())
        .bind(format!("test:{id}"))
        .execute(tx.as_mut())
        .await
        .unwrap();
        sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2")
            .bind(id)
            .bind(user)
            .execute(tx.as_mut())
            .await
            .unwrap();
    }
    tx.commit().await.unwrap();
    sqlx::query(
        "UPDATE authz_grant_ledger SET occurred_at = now() - make_interval(days => $2) WHERE user_id = $1",
    )
    .bind(user)
    .bind(age_days)
    .execute(owner)
    .await
    .unwrap();
    if notified {
        sqlx::query(
            "INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, source, channel) \
             SELECT org_id, user_id, grant_kind, grant_ref, 'NOTICE_DELIVERED', 'NOTIFIER', 'IN_APP' \
             FROM authz_grant_ledger WHERE user_id = $1 AND grant_kind = 'SYSTEM_ROLE'",
        )
        .bind(user)
        .execute(owner)
        .await
        .unwrap();
    }
    user
}

pub async fn set_roles(owner: &PgPool, actor: Option<Uuid>, user: Uuid, roles: &[&str]) {
    let mut tx = owner.begin().await.unwrap();
    if let Some(actor) = actor {
        sqlx::query("SELECT set_config('app.current_actor', $1, true)")
            .bind(actor.to_string())
            .execute(tx.as_mut())
            .await
            .unwrap();
    }
    sqlx::query("UPDATE users SET roles = $1 WHERE id = $2")
        .bind(roles)
        .bind(user)
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
}

pub fn query(requester: Uuid, excluded: &[Uuid]) -> SecondPersonQuery {
    SecondPersonQuery {
        org: OrgId::one(),
        feature: Feature::RoleManage,
        branch: None,
        requester: UserId::from_uuid(requester),
        excluded: excluded.iter().copied().map(UserId::from_uuid).collect(),
        case_created_at: OffsetDateTime::now_utc(),
        min_grant_age_days: MIN_GRANT_AGE_DAYS,
    }
}

/// The fact, computed as the serving role inside an org-armed transaction.
pub async fn fact(runtime: &PgPool, query: &SecondPersonQuery) -> SecondPersonFact {
    let mut tx = runtime.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    let fact = second_person_fact_in_tx(&mut tx, query).await.unwrap();
    tx.commit().await.unwrap();
    fact
}
