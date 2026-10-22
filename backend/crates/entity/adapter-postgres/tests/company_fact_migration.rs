// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Expand-only transfer: preserve the legacy evidence, never replace an entity.
mod common;
use common::*;
use sqlx::PgPool;
use uuid::Uuid;

const EXPAND: &str = include_str!(
    "../../../platform/db/migrations/20261023040924000_company_legal_facts_expand.sql"
);

async fn legacy(owner: &PgPool, org: Uuid, actor: Uuid, name: &str) -> serde_json::Value {
    // An N-1 writer retains its schema and insert privilege during expansion.
    sqlx::query_scalar("INSERT INTO company_revisions (org_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,1,gen_random_uuid(),$2,sha256('x'::bytea),jsonb_build_object('legal_name',$3::text,'reg_no','000-81-67897','effective_from','2020-01-01'),'{}') RETURNING to_jsonb(company_revisions)")
        .bind(org).bind(actor).bind(name).fetch_one(owner).await.unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn company_facts_are_copied_verified_and_retries_preserve_source(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "company-copy").await;
    let source = legacy(&owner, org, *actor.user.as_uuid(), "주식회사 코스").await;
    sqlx::raw_sql(EXPAND).execute(&owner).await.unwrap();
    sqlx::query("SELECT migrate_company_legal_facts()")
        .execute(&owner)
        .await
        .unwrap();
    let entities = store.list_entities(&actor, true).await.unwrap();
    assert_eq!(entities.len(), 1);
    let e = &entities[0];
    assert!(e.needs_confirmation);
    assert_eq!(e.current.as_ref().unwrap().name, "주식회사 코스");
    assert_eq!(
        e.current.as_ref().unwrap().effective_from.to_string(),
        "2020-01-01"
    );
    assert_eq!(e.registrations.len(), 1);
    assert_eq!(
        e.registrations[0].brn.as_ref().map(|n| n.display.as_str()),
        Some("000-81-67897")
    );
    let after: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(c) FROM company_revisions c WHERE org_id=$1")
            .bind(org)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(
        after, source,
        "expansion must preserve every byte of legacy history"
    );
    let provenance: serde_json::Value = sqlx::query_scalar(
        "SELECT settings_snapshot FROM legal_entity_revisions WHERE legal_entity_id=$1",
    )
    .bind(e.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(provenance["source_revision_id"], source["id"]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn runtime_cannot_execute_cross_tenant_company_fact_migration(owner: PgPool) {
    let runtime = console_platform_test_support::runtime_role_pool(&owner).await;
    let can_execute: bool = sqlx::query_scalar(
        "SELECT has_function_privilege('migrate_company_legal_facts()', 'EXECUTE')",
    )
    .fetch_one(&runtime)
    .await
    .unwrap();
    assert!(!can_execute, "the migration is owner-only");
    let error = sqlx::query("SELECT migrate_company_legal_facts()")
        .execute(&runtime)
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("42501")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn coss_cannot_overwrite_the_existing_legal_entity_name(owner: PgPool) {
    let org = Uuid::new_v4();
    let (store, actor) = tenant(&owner, org, "company-existing").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 코스", "000211-0006241"))
        .await
        .unwrap()
        .record;
    let source = legacy(&owner, org, *actor.user.as_uuid(), "COSS").await;
    sqlx::raw_sql(EXPAND).execute(&owner).await.unwrap();
    let entities = store.list_entities(&actor, true).await.unwrap();
    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].id, entity.id);
    assert_eq!(entities[0].current.as_ref().unwrap().name, "주식회사 코스");
    assert_eq!(entities[0].current.as_ref().unwrap().version, 1);
    let after: serde_json::Value =
        sqlx::query_scalar("SELECT to_jsonb(c) FROM company_revisions c WHERE org_id=$1")
            .bind(org)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(source, after);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn invalid_legacy_name_aborts_without_inventing_a_legal_name(owner: PgPool) {
    let org = Uuid::new_v4();
    let (_store, actor) = tenant(&owner, org, "company-invalid").await;
    legacy(&owner, org, *actor.user.as_uuid(), "   ").await;
    let error = sqlx::raw_sql(EXPAND).execute(&owner).await.unwrap_err();
    assert!(
        error
            .to_string()
            .contains("company legal name requires migration review")
    );
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM legal_entities WHERE org_id=$1")
        .bind(org)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(count, 0);
}
