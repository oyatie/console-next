// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{OrgId, PgPayrollStore, PgPool, UserId, Uuid, date, runtime_role_pool, seed_org};
use time::OffsetDateTime;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn submitted_inbox_page_excludes_submitter_non_submitted_and_other_org(pool: PgPool) {
    let org_a = Uuid::new_v4();
    let org_b = Uuid::new_v4();
    seed_org(&pool, org_a, "Inbox A").await;
    seed_org(&pool, org_b, "Inbox B").await;

    let submitter = seed_plain_user(&pool, org_a, "Submitter").await;
    let approver = seed_plain_user(&pool, org_a, "Approver").await;
    let outsider = seed_plain_user(&pool, org_b, "Outsider").await;
    let submitted_at = OffsetDateTime::now_utc();
    let visible = seed_run_status(
        &pool,
        org_a,
        "inbox-submitted",
        "SUBMITTED",
        Some(submitter),
        Some(submitted_at),
    )
    .await;
    let _calculated =
        seed_run_status(&pool, org_a, "inbox-calculated", "CALCULATED", None, None).await;
    let other_org = seed_run_status(
        &pool,
        org_b,
        "inbox-other-org",
        "SUBMITTED",
        Some(outsider),
        Some(submitted_at),
    )
    .await;

    let store = PgPayrollStore::new(runtime_role_pool(&pool).await);
    let as_of = submitted_at + time::Duration::seconds(1);

    let for_submitter =
        console_platform_request_context::scope_org(OrgId::from_uuid(org_a), async {
            store
                .list_submitted_action_inbox_page(submitter, as_of, None, 50, &[])
                .await
        })
        .await
        .unwrap();
    assert_eq!(for_submitter.1, 0);
    assert!(for_submitter.0.is_empty());

    let for_approver =
        console_platform_request_context::scope_org(OrgId::from_uuid(org_a), async {
            store
                .list_submitted_action_inbox_page(approver, as_of, None, 50, &[])
                .await
        })
        .await
        .unwrap();
    assert_eq!(for_approver.1, 1);
    assert_eq!(for_approver.0.len(), 1);
    assert_eq!(for_approver.0[0].id, visible);
    assert!(!for_approver.2);

    let other_org_for_approver =
        console_platform_request_context::scope_org(OrgId::from_uuid(org_b), async {
            store
                .list_submitted_action_inbox_page(approver, as_of, None, 50, &[])
                .await
        })
        .await
        .unwrap();
    assert_eq!(other_org_for_approver.1, 1);
    assert_eq!(other_org_for_approver.0[0].id, other_org);
    assert_ne!(other_org_for_approver.0[0].id, visible);

    let other_org_for_submitter =
        console_platform_request_context::scope_org(OrgId::from_uuid(org_b), async {
            store
                .list_submitted_action_inbox_page(outsider, as_of, None, 50, &[])
                .await
        })
        .await
        .unwrap();
    assert_eq!(other_org_for_submitter.1, 0);
    assert!(other_org_for_submitter.0.is_empty());
}

async fn seed_plain_user(owner_pool: &PgPool, org: Uuid, name: &str) -> UserId {
    let user_id = UserId::new();
    sqlx::query("INSERT INTO users (id, display_name, roles, org_id) VALUES ($1, $2, $3, $4)")
        .bind(*user_id.as_uuid())
        .bind(name)
        .bind(vec!["EXECUTIVE".to_string()])
        .bind(org)
        .execute(owner_pool)
        .await
        .unwrap();
    user_id
}

async fn seed_run_status(
    owner_pool: &PgPool,
    org: Uuid,
    source_label: &str,
    status: &str,
    submitted_by: Option<UserId>,
    submitted_at: Option<OffsetDateTime>,
) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO payroll_draft_runs \
         (org_id, period_start, period_end, source_label, status, submitted_by, submitted_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(org)
    .bind(date!(2026 - 06 - 01))
    .bind(date!(2026 - 06 - 30))
    .bind(source_label)
    .bind(status)
    .bind(submitted_by.map(|user| *user.as_uuid()))
    .bind(submitted_at)
    .fetch_one(owner_pool)
    .await
    .unwrap()
}
