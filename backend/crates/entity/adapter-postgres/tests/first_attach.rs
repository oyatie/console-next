#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! UX-R1 ENTITY org-03 (P0; catalog company-18) as `console_rt`: a 사업장
//! added with 「나중에 연결」 gets its own 사업자등록증 later — the certificate
//! is recorded, then linked by the dated registration change, and the 사업장
//! holds it. Also worst-case-08's reach: the 사업장 a caller's branches back.

mod common;

use common::*;
use console_entity_application::{CreateWorkplace, EntityScope};
use console_entity_domain::correction::RegistrationChangeInput;
use console_entity_domain::workplace::WorkplaceInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0C18);

fn later(name: &str) -> CreateWorkplace {
    let mut w = workplace_from(Uuid::nil(), name);
    w.input = WorkplaceInput {
        registration_id: None,
        same_address_as_registration: false,
        address: Some(address("경기도 평택시 포승읍 평택항로 1")),
        ..w.input
    };
    w.is_head_office = None;
    w
}

fn attach(registration: Uuid, on: &str) -> RegistrationChangeInput {
    RegistrationChangeInput {
        registration_id: Some(registration),
        sub_serial: None,
        effective_from: Some(on.into()),
        reason_code: Some("FIRST_ATTACH".into()),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_added_without_a_certificate_attaches_its_own(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "C").await;
    let mut input = corporation("주식회사 가나", "000211-0006241");
    input.vat_unit_mode = Some("PER_WORKPLACE".into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let seoul = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;
    store
        .create_workplace(&cmd(&actor), entity, workplace_from(seoul, "본사"), port())
        .await
        .unwrap();
    let plant = store
        .create_workplace(&cmd(&actor), entity, later("평택공장"), port())
        .await
        .unwrap()
        .record;
    assert_eq!(plant.registration_id, None);

    // Its own certificate, recorded and then linked from its 개업일.
    let own = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00071"))
        .await
        .unwrap()
        .record
        .id;
    let key = cmd(&actor);
    let linked = store
        .change_workplace_registration(&key, plant.id, attach(own, "2020-03-02"))
        .await
        .unwrap()
        .record;
    assert_eq!(linked.registration_id, Some(own));
    let holder: Option<Uuid> =
        sqlx::query_scalar("SELECT holder_workplace_id FROM business_registrations WHERE id = $1")
            .bind(own)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(
        holder,
        Some(plant.id),
        "the 사업장 holds its own certificate"
    );
    let ledger: (Option<Uuid>, Option<Uuid>, String) = sqlx::query_as(
        "SELECT from_registration_id, to_registration_id, effective_from::text \
         FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(plant.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(ledger, (None, Some(own), "2020-03-02".into()));
    let audits: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE action = 'workplace.change_registration' AND target_id = $1",
    )
    .bind(plant.id.to_string())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(audits, 1);

    // The same key again is the same answer, not a second change.
    let replay = store
        .change_workplace_registration(&key, plant.id, attach(own, "2020-03-02"))
        .await
        .unwrap()
        .record;
    assert_eq!(replay.registration_id, Some(own));
    let rows: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(plant.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(rows, 1);

    // Another 법인's certificate is refused, and nothing changes.
    let elsewhere = store
        .create_entity(&cmd(&actor), corporation("주식회사 다라", "000111-0000003"))
        .await
        .unwrap()
        .record
        .id;
    let theirs = store
        .create_registration(&cmd(&actor), elsewhere, certificate("000-81-12349"))
        .await
        .unwrap()
        .record
        .id;
    let other = store
        .create_workplace(&cmd(&actor), entity, later("판교지점"), port())
        .await
        .unwrap()
        .record;
    let err = store
        .change_workplace_registration(&cmd(&actor), other.id, attach(theirs, "2026-01-01"))
        .await
        .unwrap_err();
    assert_eq!(
        code(err).1,
        vec![("registration_id".into(), "registration_of_other_entity")]
    );
    let still: Option<Uuid> =
        sqlx::query_scalar("SELECT registration_id FROM workplaces WHERE id = $1")
            .bind(other.id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(still, None);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_branch_reach_names_the_workplaces_it_backs(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG, "B").await;
    let (_, [(hq, _), (plant, _)]) = two_workplaces(&store, &actor).await;
    let branch: Uuid = sqlx::query_scalar("SELECT default_branch_id FROM workplaces WHERE id = $1")
        .bind(hq)
        .fetch_one(&owner)
        .await
        .unwrap();
    assert_eq!(
        store
            .workplaces_on_branches(actor.org, &[branch])
            .await
            .unwrap(),
        vec![hq]
    );
    assert!(
        store
            .workplaces_on_branches(actor.org, &[])
            .await
            .unwrap()
            .is_empty()
    );
    // That reach lists only that 사업장 of its 법인, and counts only it.
    let only = console_entity_application::Actor {
        scope: EntityScope::Only(vec![hq]),
        ..actor.clone()
    };
    let seen = store.list_entities(&only, false).await.unwrap();
    assert_eq!(
        seen[0].workplaces.iter().map(|w| w.id).collect::<Vec<_>>(),
        vec![hq]
    );
    assert!(!seen[0].workplaces.iter().any(|w| w.id == plant));
}
