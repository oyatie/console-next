#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The audited delta of a dated correction must match the existing history.
mod common;
use common::{certificate, cmd, corporation, port, tenant, workplace_from};
use console_entity_application::{
    LegalEntityRevision, RegistrationRevision, RegistrationStatusInput, WorkplaceRevision,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn correction_audit_seals_actual_fields_after_a_future_revision(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "audit-fields").await;
    let original = corporation("Audited entity", "000211-0006241");
    let entity = store
        .create_entity(&cmd(&actor), original.clone())
        .await
        .unwrap()
        .record;
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut future = original.clone();
    future.name = Some("Future name".into());
    store
        .revise_entity(
            &cmd(&actor),
            entity.id,
            LegalEntityRevision {
                expected_version: Some(1),
                effective_from: Some("2099-01-01".into()),
                reason_code: Some("TRADE_NAME_CHANGE".into()),
                input: future,
            },
        )
        .await
        .unwrap();
    let mut corrected = original;
    corrected.main_phone = Some("+8225550199".into());
    store
        .revise_entity(
            &cmd(&actor),
            entity.id,
            LegalEntityRevision {
                expected_version: Some(2),
                effective_from: Some(today.to_string()),
                reason_code: Some("CORRECTION".into()),
                input: corrected,
            },
        )
        .await
        .unwrap();
    let history = store.entity_history(&actor, entity.id, true).await.unwrap();
    let fields: Vec<_> = history[0]
        .changes
        .iter()
        .map(|change| &change.field)
        .collect();
    assert_eq!(json!(fields), json!(["main_phone"]));
    let snap: Value = sqlx::query_scalar("SELECT after_snap FROM audit_events WHERE org_id=$1 AND target_id=$2 AND action='legal_entity.revise' ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(actor.org.as_uuid()).bind(entity.id.to_string()).fetch_one(&owner).await.unwrap();
    assert_eq!(snap["changed_fields"], json!(fields));
    assert!(
        !snap.to_string().contains("5550199"),
        "the field projection contains no values"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn registration_and_workplace_audit_fields_match_their_histories(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "audit-related-fields").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("Entity", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let input = certificate("000-81-00009");
    let registration = store
        .create_registration(&cmd(&actor), entity, input.clone())
        .await
        .unwrap()
        .record
        .id;
    let today: time::Date = sqlx::query_scalar("SELECT (now() AT TIME ZONE 'Asia/Seoul')::date")
        .fetch_one(&owner)
        .await
        .unwrap();
    let mut revised = input;
    revised.tax_office_label = Some("Changed office".into());
    store
        .revise_registration(
            &cmd(&actor),
            registration,
            RegistrationRevision {
                expected_version: Some(1),
                effective_from: Some(today.to_string()),
                reason_code: Some("CORRECTION".into()),
                input: revised,
            },
            RegistrationStatusInput {
                status: Some("CONTINUING".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let fields: Vec<_> = store
        .registration_history(&actor, registration, true)
        .await
        .unwrap()[0]
        .changes
        .iter()
        .map(|change| change.field.clone())
        .collect();
    assert_eq!(json!(fields), json!(["tax_office_label"]));
    assert_eq!(
        audit_fields(&owner, registration, "business_registration.revise").await,
        json!(fields)
    );

    let input = workplace_from(registration, "Original workplace");
    let workplace = store
        .create_workplace(&cmd(&actor), entity, input.clone(), port())
        .await
        .unwrap()
        .record
        .id;
    let mut revised = input.input;
    revised.name = Some("Revised workplace".into());
    revised.status = Some("CONTINUING".into());
    store
        .revise_workplace(
            &cmd(&actor),
            workplace,
            WorkplaceRevision {
                expected_version: Some(1),
                effective_from: Some(today.to_string()),
                reason_code: Some("CORRECTION".into()),
                input: revised,
            },
            port(),
        )
        .await
        .unwrap();
    let fields: Vec<_> = store
        .workplace_history(&actor, workplace, true)
        .await
        .unwrap()[0]
        .changes
        .iter()
        .map(|change| change.field.clone())
        .collect();
    assert_eq!(json!(fields), json!(["name"]));
    assert_eq!(
        audit_fields(&owner, workplace, "workplace.revise").await,
        json!(fields)
    );
}

async fn audit_fields(owner: &PgPool, id: Uuid, action: &str) -> Value {
    sqlx::query_scalar("SELECT after_snap->'changed_fields' FROM audit_events WHERE target_id=$1 AND action=$2 ORDER BY created_at DESC,id DESC LIMIT 1")
        .bind(id.to_string()).bind(action).fetch_one(owner).await.unwrap()
}
