//! BW-29 spec row 11: the second-person fact judges a custom-role holder by
//! their own live scope, never by the act's (decisions D0.2).
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

mod second_person_support;

use console_identity_adapter_postgres::second_person::SecondPersonQuery;
use console_platform_authz::Feature;
use console_platform_test_support::{runtime_role_pool, seed_branch};
use second_person_support::{fact, holder, org, query};
use sqlx::PgPool;
use uuid::Uuid;

/// Spec row 11: a custom-role holder counts only where their own live scope
/// reaches, never through the act's scope.
#[sqlx::test(migrator = "second_person_support::MIGRATOR")]
async fn a_custom_role_holder_counts_only_inside_their_own_branches(owner: PgPool) {
    let runtime = runtime_role_pool(&owner).await;
    let home = seed_branch(&owner, "Region", "Home").await;
    let elsewhere = seed_branch(&owner, "Region", "Elsewhere").await;
    let requester = holder(&owner, None, &["SUPER_ADMIN"], true, 400, true).await;
    let member = holder(&owner, None, &["MEMBER"], true, 400, true).await;
    sqlx::query("INSERT INTO user_branches (user_id, branch_id, org_id) VALUES ($1, $2, $3)")
        .bind(member)
        .bind(*home.as_uuid())
        .bind(org())
        .execute(&owner)
        .await
        .unwrap();
    let role: Uuid = sqlx::query_scalar(
        "INSERT INTO policy_roles (org_id, role_key, display_name, status, created_at, updated_at) \
         VALUES ($1, 'second_person_probe', 'Probe', 'ACTIVE', now() - interval '400 days', now() - interval '400 days') \
         RETURNING id",
    )
    .bind(org())
    .fetch_one(&owner)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO policy_role_permissions (org_id, role_id, feature_key, permission_level, created_at) \
         VALUES ($1, $2, 'user_manage', 'allow', now() - interval '400 days')",
    )
    .bind(org())
    .bind(role)
    .execute(&owner)
    .await
    .unwrap();
    sqlx::query("INSERT INTO user_role_assignments (org_id, user_id, role_id) VALUES ($1, $2, $3)")
        .bind(org())
        .bind(member)
        .bind(role)
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE authz_grant_ledger SET occurred_at = now() - interval '400 days' WHERE user_id = $1",
    )
    .bind(member)
    .execute(&owner)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO authz_grant_ledger (org_id, user_id, grant_kind, grant_ref, event, source, channel) \
         VALUES ($1, $2, 'POLICY_ROLE', $3, 'NOTICE_DELIVERED', 'NOTIFIER', 'IN_APP')",
    )
    .bind(org())
    .bind(member)
    .bind(role.to_string())
    .execute(&owner)
    .await
    .unwrap();

    let act = |branch| SecondPersonQuery {
        feature: Feature::UserManage,
        branch: Some(branch),
        ..query(requester, &[])
    };
    let got = fact(&runtime, &act(home)).await;
    assert_eq!(got.eligible, [member].into(), "{got:?}");
    let got = fact(&runtime, &act(elsewhere)).await;
    assert!(!got.eligible.contains(&member), "{got:?}");
    let org_wide = SecondPersonQuery {
        feature: Feature::UserManage,
        ..query(requester, &[])
    };
    assert!(!fact(&runtime, &org_wide).await.eligible.contains(&member));
}
