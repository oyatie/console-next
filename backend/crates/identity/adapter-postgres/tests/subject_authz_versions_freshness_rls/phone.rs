// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{runtime_role_pool, seed_active_user, seed_org};
use console_identity_adapter_postgres::PgOrgStore;
use console_identity_application::{DirectoryListQuery, UpdateUserCommand, UserListQuery};
use console_kernel_core::{BranchScope, OrgId, TraceContext};
use console_platform_request_context::CURRENT_ORG;
use sqlx::PgPool;
use time::OffsetDateTime;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn account_contact_edits_keep_person_reads_and_directory_privacy_separate(owner: PgPool) {
    let org = OrgId::one();
    seed_org(&owner, *org.as_uuid(), "A").await;
    let actor = seed_active_user(&owner, *org.as_uuid()).await;
    let target = seed_active_user(&owner, *org.as_uuid()).await;
    let store = PgOrgStore::new(runtime_role_pool(&owner).await);
    sqlx::query("SELECT console_revise_person_facts(org_id,person_id,'{\"phone\":\"+82212345678\"}'::jsonb,NULL) FROM users WHERE id=$1")
        .bind(target.as_uuid()).execute(&owner).await.unwrap();
    CURRENT_ORG
        .scope(
            org,
            store.update_user(UpdateUserCommand {
                actor,
                user_id: target,
                display_name: None,
                employee_id: None,
                phone: Some(Some("010-1234-5678".into())),
                team: None,
                roles: None,
                branch_ids: None,
                preview_receipt_id: None,
                trace: TraceContext::generate(),
                occurred_at: OffsetDateTime::now_utc(),
            }),
        )
        .await
        .unwrap();
    let contact: Option<String> = sqlx::query_scalar("SELECT phone FROM users WHERE id=$1")
        .bind(target.as_uuid())
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(contact.as_deref(), Some("+821012345678"));
    let directory = CURRENT_ORG
        .scope(
            org,
            store.list_directory_people(
                &BranchScope::All,
                DirectoryListQuery {
                    search: None,
                    team: None,
                    branch_id: None,
                    roles: Vec::new(),
                    include_inactive: false,
                    limit: None,
                    offset: None,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        directory
            .items
            .iter()
            .find(|u| u.id == target)
            .unwrap()
            .phone,
        None
    );
    let got = CURRENT_ORG
        .scope(org, store.get_user(target, &BranchScope::All))
        .await
        .unwrap();
    assert_eq!(
        got.phone.as_deref(),
        Some("+821012345678"),
        "get_user must keep phone"
    );
    let users = CURRENT_ORG
        .scope(
            org,
            store.list_users(
                &BranchScope::All,
                UserListQuery {
                    include_inactive: false,
                    limit: None,
                    offset: None,
                },
            ),
        )
        .await
        .unwrap();
    assert_eq!(
        users
            .items
            .iter()
            .find(|u| u.id == target)
            .unwrap()
            .phone
            .as_deref(),
        Some("+821012345678"),
        "list_users must keep phone"
    );
}
