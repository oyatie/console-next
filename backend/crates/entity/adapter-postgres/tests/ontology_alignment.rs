#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The ontology-alignment MUST items (INTEG-1…6), one discriminating test
//! each, as the runtime role `console_rt`.

mod common;

use common::*;
use console_entity_application::{
    Actor, LegalEntityRevision, RegistrationRevision, RegistrationStatusInput, Revision,
    WorkplaceRevision,
};
use console_entity_domain::codes::VatUnitMode;
use console_entity_domain::workplace::WorkplaceInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xE000_0000_0000_0000_0000_0000_0000_0E03);

async fn count(owner: &PgPool, sql: &'static str) -> i64 {
    sqlx::query_scalar(sql)
        .bind(ORG)
        .fetch_one(owner)
        .await
        .unwrap()
}

/// 법인 + 사업자등록, ready for 사업장.
async fn entity_with_registration(
    store: &console_entity_adapter_postgres::PgEntityStore,
    actor: &Actor,
) -> (Uuid, Uuid) {
    let id = store
        .create_entity(&cmd(actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(actor), id, certificate("000-81-00009"))
        .await
        .unwrap();
    (id, reg.record.id)
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn integ1_one_key_applies_a_command_once(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, reg) = entity_with_registration(&store, &actor).await;
    let once = cmd(&actor);
    let first = store
        .create_workplace(&once, entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    let again = store
        .create_workplace(&once, entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap();
    assert_eq!(first.record.id, again.record.id);
    assert_eq!(again.change_mode, "SETUP");
    let workplaces = count(&owner, "SELECT count(*) FROM workplaces WHERE org_id = $1").await;
    let branches = count(&owner, "SELECT count(*) FROM branches WHERE org_id = $1").await;
    let events = count(
        &owner,
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'workplace.create'",
    )
    .await;
    assert_eq!((workplaces, branches, events), (1, 1, 1));
    // The same key on another request is refused, not applied.
    let (code_, _, remedy) = code(
        store
            .create_workplace(&once, entity, workplace_from(reg, "부산지점"), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("idempotency_key_reused", Some("retry_with_new_key"))
    );
    // A write without a command id is never applied.
    let (_, fields, _) = code(
        store
            .create_workplace(&actor, entity, workplace_from(reg, "부산지점"), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(fields, vec![("Idempotency-Key".into(), "required")]);
}

fn rename(expected_version: i32, name: &str) -> WorkplaceRevision {
    let input = workplace_from(Uuid::nil(), name).input;
    Revision {
        expected_version: Some(expected_version),
        effective_from: Some("2026-01-01".into()),
        reason_code: Some("RENAME".into()),
        input: WorkplaceInput {
            registration_id: None,
            status: Some("CONTINUING".into()),
            ..input
        },
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn integ2_a_stale_revise_is_refused_with_the_current_version(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, reg) = entity_with_registration(&store, &actor).await;
    let wp = store
        .create_workplace(&cmd(&actor), entity, workplace_from(reg, "본사"), port())
        .await
        .unwrap()
        .record
        .id;
    store
        .revise_workplace(&cmd(&actor), wp, rename(1, "본사 A"), port())
        .await
        .unwrap();
    let err = store
        .revise_workplace(&cmd(&actor), wp, rename(1, "본사 B"), port())
        .await
        .unwrap_err();
    let console_entity_adapter_postgres::PgEntityError::Refused(refusal) = err else {
        panic!("expected a refusal");
    };
    assert_eq!(
        (refusal.code, refusal.current_version),
        ("stale_revision", Some(2))
    );
    let versions = count(
        &owner,
        "SELECT max(version)::bigint FROM workplace_revisions WHERE org_id = $1",
    )
    .await;
    assert_eq!(versions, 2, "no version 3");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn integ3_first_records_start_at_their_opening_dates(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, reg) = entity_with_registration(&store, &actor).await;
    let mut future = workplace_from(reg, "신규 매장");
    future.input.opened_on = Some("2099-01-02".into());
    let wp = store
        .create_workplace(&cmd(&actor), entity, future, port())
        .await
        .unwrap()
        .record;
    let state = wp.current.unwrap();
    assert_eq!(
        (
            state.effective_from.to_string().as_str(),
            state.before_first_record
        ),
        ("2099-01-02", true),
        "before 개설일 the first record shows, flagged"
    );
    let view = store.get_entity(&actor, entity, true).await.unwrap();
    let registration = view.registrations[0].current.as_ref().unwrap();
    assert_eq!(registration.effective_from.to_string(), "2020-03-02");
    assert!(!registration.before_first_record);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn integ5_a_same_named_branch_is_never_reused(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, reg) = entity_with_registration(&store, &actor).await;
    let region: Uuid = sqlx::query_scalar(
        "INSERT INTO regions (org_id, name) VALUES ($1, '주식회사 가나') RETURNING id",
    )
    .bind(ORG)
    .fetch_one(&owner)
    .await
    .unwrap();
    let existing: Uuid = sqlx::query_scalar(
        "INSERT INTO branches (org_id, region_id, name) VALUES ($1, $2, '서울지점') RETURNING id",
    )
    .bind(ORG)
    .bind(region)
    .fetch_one(&owner)
    .await
    .unwrap();
    let wp = store
        .create_workplace(
            &cmd(&actor),
            entity,
            workplace_from(reg, "서울지점"),
            port(),
        )
        .await
        .unwrap()
        .record;
    let branch = wp.default_branch_id.unwrap();
    assert_ne!(
        branch, existing,
        "a new branch: the old one's members gain no scope"
    );
    let new_region: Uuid = sqlx::query_scalar("SELECT region_id FROM branches WHERE id = $1")
        .bind(branch)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_ne!(new_region, region, "regions are not matched by name either");
    // Binding the existing branch is an explicit choice by id.
    let mut bind = workplace_from(Uuid::nil(), "서울지점 2");
    bind.input.registration_id = None;
    bind.input.same_address_as_registration = false;
    bind.input.address = Some(address("서울특별시 중구 세종대로 110"));
    bind.is_head_office = None;
    bind.default_branch_id = Some(existing);
    let bound = store
        .create_workplace(&cmd(&actor), entity, bind, port())
        .await
        .unwrap()
        .record;
    assert_eq!(bound.default_branch_id, Some(existing));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn integ6_workplace_contacts_are_personal(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, reg) = entity_with_registration(&store, &actor).await;
    let mut input = workplace_from(reg, "본사");
    input.input.representative_name = Some("김대표".into());
    input.input.mobile = Some("010-1234-5678".into());
    input.input.email = Some("owner@example.com".into());
    store
        .create_workplace(&cmd(&actor), entity, input, port())
        .await
        .unwrap();
    let reader = store.get_entity(&actor, entity, false).await.unwrap();
    let state = reader.workplaces[0].current.as_ref().unwrap();
    assert_eq!(
        (&state.representative_name, &state.mobile, &state.email),
        (&None, &None, &None),
        "a reader without the write permission sees none of the three"
    );
    let writer = store.get_entity(&actor, entity, true).await.unwrap();
    let state = writer.workplaces[0].current.as_ref().unwrap();
    assert_eq!(state.representative_name.as_deref(), Some("김대표"));
    assert!(state.mobile.is_some() && state.email.is_some());
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn integ3_a_back_dated_registration_revise_keeps_its_vat_unit(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "A").await;
    let (entity, reg) = entity_with_registration(&store, &actor).await;
    // The entity is revised later (v3 from 2026-06-01) ...
    let later: LegalEntityRevision = Revision {
        expected_version: Some(2),
        effective_from: Some("2026-06-01".into()),
        reason_code: Some("RENAME".into()),
        input: corporation("주식회사 가나다", "000211-0006241"),
    };
    store
        .revise_entity(&cmd(&actor), entity, later)
        .await
        .unwrap();
    // ... then the certificate is corrected back to 2025 as 사업자단위과세.
    let mut input = certificate("000-81-00009");
    input.unit_taxation = Some(true);
    let back: RegistrationRevision = Revision {
        expected_version: Some(1),
        effective_from: Some("2025-01-01".into()),
        reason_code: Some("CORRECTION".into()),
        input,
    };
    store
        .revise_registration(
            &cmd(&actor),
            reg,
            back,
            RegistrationStatusInput {
                status: Some("CONTINUING".into()),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    let now = store.get_entity(&actor, entity, true).await.unwrap();
    assert_eq!(
        now.current.unwrap().vat_unit_mode,
        Some(VatUnitMode::UnitTaxation),
        "the VAT unit change is not lost under the later revision"
    );
}
