#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! D26 (decisions #26): `approval.policy.org_structure` decides what submit
//! does. `none` (the default) approves at once with no approval step and
//! applies a due change in the same transaction; a future-dated one waits as
//! APPROVED and its drafter may apply it on its 시행일 without
//! `org_change_apply`. `route` keeps the BW-01 ordered steps and the apply
//! permission. Driven through the store entry points the REST handlers call.

use console_kernel_core::{ErrorKind, OrgId, UserId};
use console_orgchange_adapter_postgres::{CreateOrgChange, PgOrgChangeStore};
use console_orgchange_domain::{
    OrgChangeKind, OrgChangeStatus, OrgChangeTarget, OrgProposalOp, TargetKind,
};
use console_platform_test_support::runtime_role_pool;
use serde_json::json;
use sqlx::PgPool;
use time::{Date, Duration, OffsetDateTime, macros::offset};
use uuid::Uuid;

fn today_kst() -> Date {
    OffsetDateTime::now_utc().to_offset(offset!(+9)).date()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn none_applies_a_due_change_at_submit_without_steps(pool: PgPool) {
    let org = seed_org(&pool).await;
    console_platform_request_context::scope_org(org, async move {
        let branch = seed_branch(&pool, org).await;
        let actor = seed_user(&pool, org).await;
        let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
        let (created, _) = store
            .create(
                actor,
                close_branch(branch, "d26-none-due-key-0001", today_kst()),
            )
            .await
            .unwrap();

        let done = store.submit(actor, created.summary.id).await.unwrap();

        assert_eq!(done.summary.status, OrgChangeStatus::Applied);
        assert!(
            done.approval_steps.is_empty(),
            "no approval step under none"
        );
        let submit = done.events.iter().find(|e| e.action == "submit").unwrap();
        assert_eq!(submit.to_status.as_deref(), Some("APPROVED"));
        assert_eq!(submit.reason.as_deref(), Some("approval.policy=none"));
        assert!(done.events.iter().any(|e| e.action == "effectuate"));
        assert_eq!(open_branches(&pool, org).await, 0);
        assert_eq!(steps(&pool, org, created.summary.id).await, 0);
    })
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn none_leaves_a_future_change_approved_for_its_drafter(pool: PgPool) {
    let org = seed_org(&pool).await;
    console_platform_request_context::scope_org(org, async move {
        let branch = seed_branch(&pool, org).await;
        let actor = seed_user(&pool, org).await;
        let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
        let later = today_kst() + Duration::days(3);
        let (future, _) = store
            .create(
                actor,
                close_branch(branch, "d26-none-future-key-0001", later),
            )
            .await
            .unwrap();
        let waiting = store.submit(actor, future.summary.id).await.unwrap();
        assert_eq!(waiting.summary.status, OrgChangeStatus::Approved);
        assert!(waiting.approval_steps.is_empty());
        assert_eq!(open_branches(&pool, org).await, 1);

        // The drafter without org_change_apply reaches the 시행일 check (409),
        // never the permission refusal: on its date they apply it themselves.
        let early = store
            .effectuate(actor, future.summary.id, false)
            .await
            .unwrap_err();
        assert_eq!(early.kind(), ErrorKind::Conflict, "{early:?}");
    })
    .await;
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn route_still_creates_the_ordered_steps(pool: PgPool) {
    let org = seed_org(&pool).await;
    console_platform_request_context::scope_org(org, async move {
        let branch = seed_branch(&pool, org).await;
        let actor = seed_user(&pool, org).await;
        // A tightening (none -> route) is in force at once.
        sqlx::query(
            "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
             VALUES ($1, 'approval.policy.org_structure', '\"route\"'::jsonb, $2, 'TEST')",
        )
        .bind(*org.as_uuid())
        .bind(*actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
        let store = PgOrgChangeStore::new(runtime_role_pool(&pool).await);
        let (created, _) = store
            .create(
                actor,
                close_branch(branch, "d26-route-key-0001", today_kst()),
            )
            .await
            .unwrap();

        let submitted = store.submit(actor, created.summary.id).await.unwrap();

        assert_eq!(submitted.summary.status, OrgChangeStatus::InApproval);
        assert_eq!(submitted.approval_steps.len(), 4);
        assert_eq!(open_branches(&pool, org).await, 1);
        // Under route applying still needs org_change_apply.
        let refused = store
            .effectuate(actor, created.summary.id, false)
            .await
            .unwrap_err();
        assert_eq!(refused.kind(), ErrorKind::Forbidden, "{refused:?}");
    })
    .await;
}

/// Decisions #18 retired creating a 지점 (MR-20); closing a legacy one that
/// backs no 사업장 is still an org change, so it carries the policy here.
fn close_branch(branch: Uuid, key: &str, effective_date: Date) -> CreateOrgChange {
    CreateOrgChange {
        kind: OrgChangeKind::Reorg,
        target: OrgChangeTarget {
            kind: TargetKind::Branch,
            target_ref: branch.to_string(),
            label: "D26 개편".into(),
        },
        effective_date,
        reason: "지점 폐쇄".into(),
        proposal: vec![OrgProposalOp::DeactivateBranch { branch_id: branch }],
        supersedes_id: None,
        idempotency_key: key.to_owned(),
        fingerprint_input: json!({ "key": key }),
    }
}

async fn armed(pool: &PgPool, org: OrgId) -> sqlx::Transaction<'static, sqlx::Postgres> {
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(org.as_uuid().to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx
}

async fn open_branches(pool: &PgPool, org: OrgId) -> i64 {
    let mut tx = armed(pool, org).await;
    sqlx::query_scalar("SELECT count(*) FROM branches WHERE deactivated_at IS NULL")
        .fetch_one(tx.as_mut())
        .await
        .unwrap()
}

async fn steps(pool: &PgPool, org: OrgId, request: Uuid) -> i64 {
    let mut tx = armed(pool, org).await;
    sqlx::query_scalar("SELECT count(*) FROM org_change_approval_steps WHERE request_id = $1")
        .bind(request)
        .fetch_one(tx.as_mut())
        .await
        .unwrap()
}

async fn seed_org(pool: &PgPool) -> OrgId {
    let slug = format!("d26{}", &Uuid::new_v4().simple().to_string()[..12]);
    let id: Uuid =
        sqlx::query_scalar("INSERT INTO organizations (slug, name) VALUES ($1, $1) RETURNING id")
            .bind(&slug)
            .fetch_one(pool)
            .await
            .unwrap();
    OrgId::from_uuid(id)
}

/// A legacy 지점 with no 사업장 behind it.
async fn seed_branch(pool: &PgPool, org: OrgId) -> Uuid {
    let region: Uuid = sqlx::query_scalar(
        "INSERT INTO regions (name, org_id) VALUES ('D26 권역', $1) RETURNING id",
    )
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap();
    sqlx::query_scalar(
        "INSERT INTO branches (region_id, name, org_id) VALUES ($1, 'D26 지점', $2) RETURNING id",
    )
    .bind(region)
    .bind(*org.as_uuid())
    .fetch_one(pool)
    .await
    .unwrap()
}

/// The org-change holder (the store takes the actor; REST does the authz).
async fn seed_user(pool: &PgPool, org: OrgId) -> UserId {
    let user = UserId::new();
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, is_active, org_id) \
         VALUES ($1, 'd26', ARRAY['ADMIN'], true, $2)",
    )
    .bind(*user.as_uuid())
    .bind(*org.as_uuid())
    .execute(pool)
    .await
    .unwrap();
    user
}
