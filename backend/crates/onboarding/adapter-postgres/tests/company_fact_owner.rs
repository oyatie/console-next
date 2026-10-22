// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Setup confirmation and preview names come from the legal-entity record.
mod common;
use common::*;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn setup_confirms_the_entity_and_never_uses_the_tenant_legal_name_copy(owner: PgPool) {
    let (store, actor) = tenant(&owner).await;
    let entity = Uuid::new_v4();
    sqlx::query("INSERT INTO legal_entities (org_id,id,needs_confirmation,created_change_mode) VALUES ($1,$2,true,'MIGRATION')")
        .bind(actor.org.as_uuid()).bind(entity).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01','주식회사 코스','MIGRATION','CREATE',sha256('x'::bytea),'{}')")
        .bind(actor.org.as_uuid()).bind(entity).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO company_revisions (org_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,1,gen_random_uuid(),$2,sha256('x'::bytea),'{\"legal_name\":\"COSS\"}','{}')")
        .bind(actor.org.as_uuid()).bind(actor.user.as_uuid()).execute(&owner).await.unwrap();
    let checklist = store.checklist(&actor).await.unwrap();
    let step = checklist.steps.iter().find(|s| s.key == "entity").unwrap();
    assert_eq!(step.remedy, Some("confirm_legal_entity"));
    assert!(!checklist.steps.iter().any(|s| s.key == "company_names"));
    let preview = serde_json::to_string(&store.preview(&actor).await.unwrap()).unwrap();
    assert!(preview.contains("주식회사 코스"));
    assert!(!preview.contains("COSS"));
}
