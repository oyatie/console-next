// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Missing registrations are read once for the preview and the audited command.
mod common;
use common::*;
use console_onboarding_adapter_postgres::PgOnboardingError;
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn missing_registration_refuses_go_live_until_pending_or_numbered(owner: PgPool) {
    let (store, a) = tenant(&owner).await;
    let org = *a.org.as_uuid();
    let pending = Uuid::new_v4();
    let missing = Uuid::new_v4();
    // rls-arming: ok owner-only synthetic fixtures; reads and commands use console_rt.
    let mut tx = owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    for (entity, name) in [(pending, "신청 중 법인"), (missing, "미등록 법인")] {
        let workplace = Uuid::new_v4();
        sqlx::query("INSERT INTO legal_entities (org_id,id,primary_workplace_id,biz_kind,created_change_mode) VALUES ($1,$2,$3,'CORPORATION','MIGRATION')")
            .bind(org).bind(entity).bind(workplace).execute(tx.as_mut()).await.unwrap();
        sqlx::query("INSERT INTO legal_entity_revisions (org_id,legal_entity_id,version,command_id,effective_from,name,change_mode,reason_code,payload_digest,settings_snapshot) VALUES ($1,$2,1,gen_random_uuid(),'2020-01-01',$3,'MIGRATION','CREATE',sha256('x'::bytea),'{}')")
            .bind(org).bind(entity).bind(name).execute(tx.as_mut()).await.unwrap();
        sqlx::query("INSERT INTO workplaces (org_id,id,legal_entity_id,default_branch_id,created_change_mode) VALUES ($1,$2,$3,gen_random_uuid(),'MIGRATION')")
            .bind(org).bind(workplace).bind(entity).execute(tx.as_mut()).await.unwrap();
    }
    let department = Uuid::new_v4();
    sqlx::query("INSERT INTO org_units (org_id,id) VALUES ($1,$2)")
        .bind(org)
        .bind(department)
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("INSERT INTO org_unit_revisions (org_id,org_unit_id,version,command_id,actor_id,payload_digest,attributes,receipt) VALUES ($1,$2,1,gen_random_uuid(),$3,sha256('x'::bytea),'{\"name\":\"본사\",\"kind\":\"department\",\"status\":\"active\"}','{}')")
        .bind(org).bind(department).bind(a.user.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    sqlx::query("INSERT INTO business_registrations (org_id,legal_entity_id,brn_pending_reason,created_change_mode) VALUES ($1,$2,'NEW_REGISTRATION_PENDING','MIGRATION')")
        .bind(org).bind(pending).execute(&owner).await.unwrap();
    let hash = publish(&owner, "registration-test", "Test terms", 1).await;
    store
        .accept_terms(&a, "registration-test".into(), hash)
        .await
        .unwrap();

    let p = store.preview(&a).await.unwrap();
    let blocker = p
        .blockers
        .iter()
        .find(|b| b.code == "entity_without_registration")
        .expect("only the entity without a registration must block");
    assert_eq!(p.blockers.len(), 1);
    assert_eq!(blocker.count, Some(1));
    assert_eq!(blocker.remedy, Some("add_registration"));
    assert_eq!(blocker.records.len(), 1);
    assert_eq!(blocker.records[0].id, missing.to_string());
    assert_eq!(blocker.records[0].name, "미등록 법인");
    let checklist = store.checklist(&a).await.unwrap();
    let entity = &checklist.steps[0];
    assert_eq!(entity.state, console_onboarding_domain::StepState::Todo);
    assert_eq!(entity.action, "add_registration");
    assert_eq!(entity.remedy, blocker.remedy);
    assert_eq!(entity.count, blocker.count);
    let before = snapshot(&owner, &a).await;
    let error = store.go_live(&a, p.digest, false, true).await.unwrap_err();
    assert!(
        matches!(&error, PgOnboardingError::Refused { fields, remedy, .. }
        if fields.contains(&"entities_without_registration") && *remedy == Some("add_registration"))
    );
    refused(&owner, &a, before, error, "go_live_blocked").await;

    let registration = Uuid::new_v4();
    sqlx::query("INSERT INTO business_registrations (org_id,id,legal_entity_id,brn_pending_reason,created_change_mode) VALUES ($1,$2,$3,'NEW_REGISTRATION_PENDING','MIGRATION')")
        .bind(org).bind(registration).bind(missing).execute(&owner).await.unwrap();
    let fixed = store.preview(&a).await.unwrap();
    assert!(fixed.blockers.is_empty(), "{:?}", fixed.blockers);
    let checklist = store.checklist(&a).await.unwrap();
    assert_ne!(checklist.steps[0].remedy, Some("add_registration"));
    assert_ne!(
        checklist.steps[0].state,
        console_onboarding_domain::StepState::Todo
    );
    for (brn, reason) in [
        (Some("0008100009"), None),
        (None, Some("NEW_REGISTRATION_PENDING")),
    ] {
        sqlx::query("UPDATE business_registrations SET brn=$2,brn_pending_reason=$3 WHERE id=$1")
            .bind(registration)
            .bind(brn)
            .bind(reason)
            .execute(&owner)
            .await
            .unwrap();
        assert!(store.preview(&a).await.unwrap().blockers.is_empty());
    }
    // A closed registration is no longer an active registration for this entity.
    sqlx::query("UPDATE business_registrations SET closed_on='2020-01-01' WHERE id=$1")
        .bind(registration)
        .execute(&owner)
        .await
        .unwrap();
    assert!(
        store
            .preview(&a)
            .await
            .unwrap()
            .blockers
            .iter()
            .any(|b| b.code == "entity_without_registration")
    );
    sqlx::query("UPDATE business_registrations SET closed_on=NULL WHERE id=$1")
        .bind(registration)
        .execute(&owner)
        .await
        .unwrap();
    sqlx::query(
        "UPDATE business_registrations SET voided_at=now(),void_reason_code='TEST' WHERE id=$1",
    )
    .bind(registration)
    .execute(&owner)
    .await
    .unwrap();
    assert!(
        store
            .preview(&a)
            .await
            .unwrap()
            .blockers
            .iter()
            .any(|b| b.code == "entity_without_registration")
    );
    let registration = Uuid::new_v4();
    sqlx::query("INSERT INTO business_registrations (org_id,id,legal_entity_id,brn_pending_reason,created_change_mode) VALUES ($1,$2,$3,'NEW_REGISTRATION_PENDING','MIGRATION')")
    .bind(org)
    .bind(registration)
    .bind(missing)
    .execute(&owner)
    .await
    .unwrap();
    let fixed = store.preview(&a).await.unwrap();
    store.go_live(&a, fixed.digest, false, true).await.unwrap();
    assert_eq!(snapshot(&owner, &a).await.0, "OPERATING");
    sqlx::query(
        "UPDATE business_registrations SET voided_at=now(),void_reason_code='TEST' WHERE id=$1",
    )
    .bind(registration)
    .execute(&owner)
    .await
    .unwrap();
    assert!(
        !store
            .preview(&a)
            .await
            .unwrap()
            .blockers
            .iter()
            .any(|b| b.code == "entity_without_registration")
    );
}
