#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! ENT-REG as the runtime role `console_rt`: a 사업장 moves to another
//! 사업자등록 or 종사업장 일련번호 as a dated, ledgered change (MR-18), and
//! the 독립 근기법 사업장 evidence is read back so a revise can resend it (MR-6).

mod common;

use common::*;
use console_entity_application::WorkplaceRevision;
use console_entity_domain::correction::RegistrationChangeInput;
use sqlx::PgPool;
use uuid::Uuid;

const ORG_A: Uuid = Uuid::from_u128(0xA000_0000_0000_0000_0000_0000_0000_0E18);

fn change(registration: Uuid, serial: Option<&str>, on: &str) -> RegistrationChangeInput {
    RegistrationChangeInput {
        registration_id: Some(registration),
        sub_serial: serial.map(Into::into),
        effective_from: Some(on.into()),
        reason_code: Some("BRANCH_CONSOLIDATED".into()),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_workplace_moves_to_another_registration_with_its_holder(owner: PgPool) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let mut input = corporation("주식회사 가나", "000211-0006241");
    input.vat_unit_mode = Some("PER_WORKPLACE".into());
    let entity = store
        .create_entity(&cmd(&actor), input)
        .await
        .unwrap()
        .record
        .id;
    let reg = |brn: &'static str| {
        let (store, actor) = (store.clone(), actor.clone());
        async move {
            store
                .create_registration(&cmd(&actor), entity, certificate(brn))
                .await
                .unwrap()
                .record
                .id
        }
    };
    let (seoul, busan) = (reg("000-81-00009").await, reg("000-81-00071").await);
    let hq = store
        .create_workplace(&cmd(&actor), entity, workplace_from(seoul, "본사"), port())
        .await
        .unwrap()
        .record;
    let mut branch_input = workplace_from(busan, "부산지점");
    branch_input.is_head_office = None;
    let branch = store
        .create_workplace(&cmd(&actor), entity, branch_input, port())
        .await
        .unwrap()
        .record;

    let refused = |e| code(e).1;
    let future = store
        .change_workplace_registration(&cmd(&actor), branch.id, change(seoul, None, "2999-01-01"))
        .await;
    assert_eq!(
        refused(future.unwrap_err()),
        vec![("effective_from".into(), "date_in_future")]
    );
    let same = store
        .change_workplace_registration(&cmd(&actor), branch.id, change(busan, None, "2026-01-01"))
        .await;
    assert_eq!(
        refused(same.unwrap_err()),
        vec![("registration_id".into(), "registration_unchanged")]
    );

    let moved = store
        .change_workplace_registration(&cmd(&actor), branch.id, change(seoul, None, "2026-01-01"))
        .await
        .unwrap();
    assert_eq!(
        (moved.record.registration_id, moved.change_mode.as_str()),
        (Some(seoul), "SETUP")
    );
    let holder: Option<Uuid> =
        sqlx::query_scalar("SELECT holder_workplace_id FROM business_registrations WHERE id = $1")
            .bind(busan)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(holder, None, "the registration it left has no holder now");
    let ledger: (Option<Uuid>, Option<Uuid>, String) = sqlx::query_as(
        "SELECT from_registration_id, to_registration_id, effective_from::text FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(branch.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(ledger, (Some(busan), Some(seoul), "2026-01-01".into()));

    let history = store
        .workplace_history(&actor, branch.id, false)
        .await
        .unwrap();
    let link = history[0]
        .changes
        .iter()
        .find(|c| c.field == "registration_id")
        .unwrap();
    assert_eq!(link.after, Some(seoul.to_string()));

    // The 본사 holds 서울 and the branch files under it now: it cannot leave.
    let (code_, _, remedy) = code(
        store
            .change_workplace_registration(&cmd(&actor), hq.id, change(busan, None, "2026-01-01"))
            .await
            .unwrap_err(),
    );
    assert_eq!(
        (code_, remedy),
        ("registration_holder_in_use", Some("move_workplaces_first"))
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_serial_changes_only_by_a_registration_change_and_lsa_evidence_reads_back(
    owner: PgPool,
) {
    let (store, actor) = tenant(&owner, ORG_A, "A").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let mut cert = certificate("000-81-00009");
    cert.unit_taxation = Some(true);
    let unit = store
        .create_registration(&cmd(&actor), entity, cert)
        .await
        .unwrap()
        .record
        .id;
    store
        .create_workplace(&cmd(&actor), entity, workplace_from(unit, "본사"), port())
        .await
        .unwrap();
    let mut factory = workplace_from(unit, "공장");
    factory.is_head_office = None;
    factory.input.sub_serial = Some("0001".into());
    factory.input.independent_lsa_unit = Some(true);
    factory.input.independent_lsa_evidence = Some("별도 취업규칙과 노무관리".into());
    let factory = store
        .create_workplace(&cmd(&actor), entity, factory, port())
        .await
        .unwrap()
        .record;
    let state = factory.current.as_ref().unwrap();
    assert_eq!(
        state.independent_lsa_evidence.as_deref(),
        Some("별도 취업규칙과 노무관리")
    );

    // A revise resends what it read; a different serial is a registration change.
    let mut input = workplace_from(unit, "공장 (개명)").input;
    input.sub_serial = Some("0002".into());
    input.status = Some("CONTINUING".into());
    input.independent_lsa_unit = state.independent_lsa_unit;
    input.independent_lsa_evidence = state.independent_lsa_evidence.clone();
    let rev = |input| WorkplaceRevision {
        expected_version: Some(state.version),
        effective_from: Some("2030-01-01".into()),
        reason_code: Some("RENAME".into()),
        input,
    };
    let (_, fields, _) = code(
        store
            .revise_workplace(&cmd(&actor), factory.id, rev(input.clone()), port())
            .await
            .unwrap_err(),
    );
    assert_eq!(
        fields,
        vec![("sub_serial".into(), "use_registration_change")]
    );
    input.sub_serial = Some("0001".into());
    store
        .revise_workplace(&cmd(&actor), factory.id, rev(input), port())
        .await
        .unwrap();

    let no_serial = store
        .change_workplace_registration(&cmd(&actor), factory.id, change(unit, None, "2026-01-01"))
        .await;
    assert_eq!(
        code(no_serial.unwrap_err()).1,
        vec![("sub_serial".into(), "required")]
    );
    let renumbered = store
        .change_workplace_registration(
            &cmd(&actor),
            factory.id,
            change(unit, Some("0002"), "2026-01-01"),
        )
        .await
        .unwrap();
    assert_eq!(renumbered.record.sub_serial.as_deref(), Some("0002"));
}
