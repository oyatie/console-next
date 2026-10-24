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

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_remedy_follows_current_number_evidence_not_legacy_tier(owner: PgPool) {
    let (store, actor) = tenant(&owner).await;
    let entity = Uuid::new_v4();
    let registration = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO legal_entities (org_id,id,biz_kind,created_change_mode) VALUES ($1,$2,'INDIVIDUAL','MIGRATION')",
    )
    .bind(actor.org.as_uuid())
    .bind(entity)
    .execute(&owner)
    .await
    .unwrap();
    sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01','조회 법인','MIGRATION','CREATE',sha256('x'::bytea),'{}')").bind(actor.org.as_uuid()).bind(entity).execute(&owner).await.unwrap();
    sqlx::query("INSERT INTO business_registrations (org_id,id,legal_entity_id,brn,verification_tier,created_change_mode) VALUES ($1,$2,$3,'0008100009','T2','MIGRATION')").bind(actor.org.as_uuid()).bind(registration).bind(entity).execute(&owner).await.unwrap();
    assert!(
        serde_json::to_string(&store.preview(&actor).await.unwrap())
            .unwrap()
            .contains("registration_unverified")
    );
    sqlx::query("INSERT INTO business_registration_checks(org_id,id,registration_id,brn_checked,kind,trigger,b_stt_cd,reported_status,not_registered,fields_sent,response_sha256,provider_version) VALUES ($1,gen_random_uuid(),$2,'0008100009','STATUS','SCHEDULE','01','CONTINUING',false,ARRAY['b_no'],repeat('f',64),'fake/1')").bind(actor.org.as_uuid()).bind(registration).execute(&owner).await.unwrap();
    assert!(
        !serde_json::to_string(&store.preview(&actor).await.unwrap())
            .unwrap()
            .contains("registration_unverified")
    );
    sqlx::query("UPDATE business_registrations SET brn='0008100071' WHERE id=$1")
        .bind(registration)
        .execute(&owner)
        .await
        .unwrap();
    assert!(
        serde_json::to_string(&store.preview(&actor).await.unwrap())
            .unwrap()
            .contains("registration_unverified")
    );
    let count: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM business_registration_checks WHERE registration_id=$1",
    )
    .bind(registration)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(count, 1);
}
