#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! The solo first-run path, as the runtime role `console_rt` (FORCE RLS):
//! 법인 → 사업자등록 → 사업장 in SETUP with no second person, audited and
//! marked SETUP; then the OPERATING refusals and tenant isolation.

mod common;

use common::*;
use console_entity_application::{BindAssignment, VoidRecord};
use console_entity_domain::codes::{VatUnitBasis, VatUnitMode};
use console_entity_domain::workplace::WithholdingTarget;
use sqlx::PgPool;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E01);
const ORG_B: Uuid = Uuid::from_u128(0xB000_0000_0000_0000_0000_0000_0000_0E01);

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_new_tenant_opens_in_setup_and_builds_its_entity_alone(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap();
    assert_eq!(entity.change_mode, "SETUP");
    let id = entity.record.id;
    assert_eq!(
        entity.record.crn.as_ref().unwrap().display,
        "000211-0006241"
    );
    assert_eq!(
        entity.record.current.as_ref().unwrap().representatives,
        Some(vec!["홍길동".to_owned()])
    );

    let reg = store
        .create_registration(&cmd(&actor), id, certificate("000-81-00009"))
        .await
        .unwrap();
    assert!(reg.warnings.is_empty());
    let after = store.get_entity(&actor, id, true).await.unwrap();
    let state = after.current.unwrap();
    assert_eq!(state.vat_unit_mode, Some(VatUnitMode::PerWorkplace));
    assert_eq!(
        state.vat_unit_mode_basis,
        Some(VatUnitBasis::SingleRegistration)
    );
    // The VAT-unit revision carries the named representatives over.
    assert_eq!(state.representatives, Some(vec!["홍길동".to_owned()]));

    let wp = store
        .create_workplace(
            &cmd(&actor),
            id,
            workplace_from(reg.record.id, "본사"),
            port(),
        )
        .await
        .unwrap()
        .record;
    assert!(wp.is_primary && wp.is_head_office);
    assert!(
        wp.default_branch_id.is_some(),
        "a default branch backs the 사업장"
    );
    assert_eq!(wp.insurance.len(), 4);
    assert!(matches!(wp.withholding, WithholdingTarget::SelfUnit { .. }));
    assert!(
        wp.current.unwrap().address.is_some(),
        "address reused from the certificate"
    );

    // Setup writes are audited and marked.
    let marked: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE org_id = $1 AND classification_badges @> ARRAY['setup'] \
         AND after_snap->>'change_mode' = 'SETUP'",
    )
    .bind(ORG_A)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(marked, 3);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn duplicates_and_undecided_vat_unit_are_refused_with_fields(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let id = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    store
        .create_registration(&cmd(&actor), id, certificate("000-81-00009"))
        .await
        .unwrap();
    let (code_, fields, _) = code(
        store
            .create_registration(&cmd(&actor), id, certificate("000-81-00009"))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, fields),
        (
            "validation_failed",
            vec![("brn".into(), "brn_already_registered")]
        )
    );
    // A second 사업장 registration: the VAT unit is now a choice (no default).
    let (_, fields, remedy) = code(
        store
            .create_registration(&cmd(&actor), id, certificate("000-81-00071"))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (fields, remedy),
        (
            vec![("vat_unit_mode".into(), "required")],
            Some("declare_vat_unit_mode")
        )
    );
    let (_, fields, _) = code(
        store
            .create_entity(&cmd(&actor), corporation("다른 법인", "000211-0006241"))
            .await
            .unwrap_err(),
    );
    assert_eq!(fields, vec![("crn".into(), "crn_already_registered")]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn after_go_live_structure_writes_are_governed_and_an_unused_entity_is_still_deleted(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let id = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    set_operating(&owner, ORG_A).await;
    // Structure writes stay possible, now marked GOVERNED.
    let reg = store
        .create_registration(&cmd(&actor), id, certificate("000-81-00009"))
        .await
        .unwrap();
    assert_eq!(reg.change_mode, "GOVERNED");
    let void = VoidRecord {
        reason_code: Some("MISTAKE".into()),
    };
    store
        .void_entity(&cmd(&actor), id, void, port())
        .await
        .unwrap();
    let voided: bool =
        sqlx::query_scalar("SELECT voided_at IS NOT NULL FROM legal_entities WHERE id = $1")
            .bind(id)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert!(voided);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_mistaken_entity_is_voided_in_setup_unless_people_point_at_it(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let id = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let reg = store
        .create_registration(&cmd(&actor), id, certificate("000-81-00009"))
        .await
        .unwrap();
    let wp = store
        .create_workplace(
            &cmd(&actor),
            id,
            workplace_from(reg.record.id, "본사"),
            port(),
        )
        .await
        .unwrap()
        .record;
    let employee: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
         VALUES ($1, '주식회사 가나', '김직원', 'x', 'x', 1, 'k1') RETURNING id",
    )
    .bind(ORG_A)
    .fetch_one(&owner)
    .await
    .unwrap();
    let bind = BindAssignment {
        employee_id: employee,
        legal_entity_id: Some(id),
        workplace_id: Some(wp.id),
        valid_from: Some("2026-10-01".into()),
    };
    assert_eq!(
        store
            .bind_assignment(&cmd(&actor), bind)
            .await
            .unwrap()
            .cause,
        "SETUP_BIND"
    );
    // The same placement bound again (a client binding after a registration
    // that already placed the person) changes nothing: no CORRECTION row.
    let again = BindAssignment {
        employee_id: employee,
        legal_entity_id: Some(id),
        workplace_id: Some(wp.id),
        valid_from: Some("2026-10-01".into()),
    };
    let same = store.bind_assignment(&cmd(&actor), again).await.unwrap();
    assert_eq!(same.cause, "SETUP_BIND");
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM employment_assignments WHERE employee_id = $1")
            .bind(employee)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(rows, 1);
    let placed = store.list_assignments(&actor, employee).await.unwrap();
    assert_eq!((placed.len(), placed[0].workplace_id), (1, Some(wp.id)));
    let void = || VoidRecord {
        reason_code: Some("MISTAKE".into()),
    };
    let (code_, _, remedy) = code(
        store
            .void_entity(&cmd(&actor), id, void(), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("record_in_use", Some("reassign_people_first"))
    );
    let spare = store
        .create_entity(&cmd(&actor), corporation("테스트 법인", "000111-0000003"))
        .await
        .unwrap()
        .record
        .id;
    store
        .void_entity(&cmd(&actor), spare, void(), port())
        .await
        .unwrap();
    let left: Vec<Uuid> = store
        .list_entities(&actor, false)
        .await
        .unwrap()
        .into_iter()
        .map(|e| e.id)
        .collect();
    assert_eq!(left, vec![id]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn tenants_never_see_each_others_entities(owner: PgPool) {
    let (store_a, actor_a) = tenant(&owner, ORG_A, "A").await;
    let (store_b, actor_b) = tenant(&owner, ORG_B, "B").await;
    let a = store_a
        .create_entity(&cmd(&actor_a), corporation("가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    // Same 법인등록번호 in another tenant is allowed (a 노무법인 manages clients).
    store_b
        .create_entity(&cmd(&actor_b), corporation("가나", "000211-0006241"))
        .await
        .unwrap();
    assert_eq!(
        store_b.list_entities(&actor_b, false).await.unwrap().len(),
        1
    );
    let (code_, _, _) = code(store_b.get_entity(&actor_b, a, false).await.unwrap_err());
    assert_eq!(code_, "legal_entity_not_found");
}
