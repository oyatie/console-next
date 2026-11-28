// SPDX-License-Identifier: LicenseRef-Proprietary
use super::{fixtures, http, settings_support};
use console_compliance_adapter_postgres::{PgComplianceStore, rights};
use console_kernel_core::UserId;
use sqlx::PgPool;
use uuid::Uuid;
#[path = "../../../test-support/person_fixtures.rs"]
mod people;

pub(super) async fn file_for_independent_handler(pool: &PgPool, org: Uuid, user: UserId) -> UserId {
    // A privacy rights request reaches a handler who may edit HR records, not its own subject.
    let hr = http::add_user(pool, org, &["MEMBER"]).await;
    let (subject, _) = people::bind_user_to_distinct_person(pool, user).await;
    people::bind_user_to_distinct_person(pool, hr).await;
    let grant = settings_support::seed_role_and_grant(pool, org, user, hr, "TENANT", None).await;
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) SELECT org_id,role_id,2,name_ko,status,change_mode,created_by FROM access_role_versions WHERE org_id=$1 AND version=1 AND role_id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org).bind(grant).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) SELECT org_id,role_id,2,'hr_basic',ARRAY['edit'] FROM access_grants WHERE org_id=$1 AND id=$2")
        .bind(org).bind(grant).execute(pool).await.unwrap();
    sqlx::query("UPDATE access_roles SET version=2 WHERE org_id=$1 AND id=(SELECT role_id FROM access_grants WHERE id=$2)")
        .bind(org).bind(grant).execute(pool).await.unwrap();
    let runtime = fixtures::runtime_pool(pool).await;
    let register = PgComplianceStore::new(runtime.clone())
        .statutory_register()
        .await
        .unwrap();
    let tenant = console_kernel_core::OrgId::from_uuid(org);
    let filing = serde_json::from_str(r#"{"controller":"TENANT","kinds":["ACCESS"]}"#).unwrap();
    let mut tx = rights::begin(&runtime, tenant).await.unwrap();
    rights::file(&mut tx, tenant, user, Some(subject), &filing, &register)
        .await
        .unwrap();
    tx.commit().await.unwrap();
    hr
}
