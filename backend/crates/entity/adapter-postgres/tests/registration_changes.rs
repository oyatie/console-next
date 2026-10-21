#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! ENT-REG as the runtime role `console_rt`: a 사업장 moves to another
//! 사업자등록 or 종사업장 일련번호 as a dated, ledgered change (MR-18), and
//! the 독립 근기법 사업장 evidence is read back so a revise can resend it (MR-6).

mod common;

use common::*;
use console_entity_application::{CreateWorkplace, WorkplaceRevision};
use console_entity_domain::correction::RegistrationChangeInput;
use console_entity_domain::insurance::InsuranceSetupInput;
use console_entity_domain::legal_entity::CodeInput;
use console_entity_domain::workplace::WorkplaceInput;
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

fn not_registered(name: &str, is_abstract: bool) -> CreateWorkplace {
    CreateWorkplace {
        input: WorkplaceInput {
            name: Some(name.into()),
            reg_mode: Some("NOT_REQUIRED".into()),
            not_registered_reason: Some(CodeInput {
                code: Some(if is_abstract {
                    "REMOTE_TELEWORK".into()
                } else {
                    "VAT_DEPOT".into()
                }),
                version: Some("2026-10-22".into()),
            }),
            is_abstract: Some(is_abstract),
            address: (!is_abstract).then(|| address("서울특별시 강남구 테헤란로 153")),
            opened_on: Some("2020-03-02".into()),
            insurance: Some(InsuranceSetupInput {
                shortcut: Some("NONE_YET".into()),
                insurers: vec![],
            }),
            ..WorkplaceInput::default()
        },
        is_primary: None,
        is_head_office: Some(false),
        default_branch_id: None,
        kind_code: None,
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
    let unlinked = store
        .change_workplace_registration(
            &cmd(&actor),
            factory.id,
            RegistrationChangeInput {
                registration_id: None,
                sub_serial: None,
                effective_from: Some("2026-01-02".into()),
                reason_code: Some("분리 신고".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(unlinked.record.registration_id, None);
    assert_eq!(unlinked.record.sub_serial, None);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn abstract_and_exempt_registration_answers_are_safe_to_revise_and_attach(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "registration-answer").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    let registration = store
        .create_registration(&cmd(&actor), entity, certificate("000-81-00009"))
        .await
        .unwrap()
        .record
        .id;

    let abstract_workplace = store
        .create_workplace(
            &cmd(&actor),
            entity,
            not_registered("주소 없는 묶음", true),
            port(),
        )
        .await
        .unwrap()
        .record;
    let stored_address: Option<Uuid> = sqlx::query_scalar(
        "SELECT address_id FROM workplace_revisions WHERE workplace_id = $1 AND version = 1",
    )
    .bind(abstract_workplace.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        stored_address, None,
        "the migration accepts an abstract revision"
    );
    let ledger_before: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(abstract_workplace.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    let refused = store
        .change_workplace_registration(
            &cmd(&actor),
            abstract_workplace.id,
            change(registration, None, "2026-01-01"),
        )
        .await
        .unwrap_err();
    assert_eq!(
        code(refused).1,
        vec![(
            "registration_id".into(),
            "abstract_workplace_not_registrable"
        )]
    );
    let ledger_after: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(abstract_workplace.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        ledger_after, ledger_before,
        "a refusal writes no change row"
    );

    let exempt = store
        .create_workplace(
            &cmd(&actor),
            entity,
            not_registered("물류 하치장", false),
            port(),
        )
        .await
        .unwrap()
        .record;
    let current = exempt.current.as_ref().unwrap();
    let mut revise = not_registered("물류 하치장 (정정)", false).input;
    revise.status = Some("CONTINUING".into());
    let revised = store
        .revise_workplace(
            &cmd(&actor),
            exempt.id,
            WorkplaceRevision {
                expected_version: Some(current.version),
                effective_from: Some("2026-01-01".into()),
                reason_code: Some("CONTACT_CHANGED".into()),
                input: revise,
            },
            port(),
        )
        .await
        .unwrap()
        .record;
    assert_eq!(
        revised.not_registered_reason.as_ref().unwrap().code,
        "VAT_DEPOT"
    );
    assert!(!revised.is_abstract);
    let structure = store.org_structure(&actor).await.unwrap();
    for workplace in [abstract_workplace.id, exempt.id] {
        let node = structure.entities[0]
            .children
            .iter()
            .find(|node| node.id == workplace)
            .unwrap();
        assert!(!node.chips.contains(&"registration_missing"));
    }

    let attached = store
        .change_workplace_registration(
            &cmd(&actor),
            exempt.id,
            change(registration, None, "2026-01-01"),
        )
        .await
        .unwrap()
        .record;
    assert_eq!(attached.registration_id, Some(registration));
    assert_eq!(attached.not_registered_reason, None);
    let ledger: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT from_not_registered_reason_code, to_not_registered_reason_code \
         FROM workplace_registration_changes WHERE workplace_id = $1",
    )
    .bind(exempt.id)
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(ledger, (Some("VAT_DEPOT".into()), None));
    let answer_events: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events WHERE target_id IN ($1, $2) \
         AND action = 'workplace.registration_answer.changed'",
    )
    .bind(abstract_workplace.id.to_string())
    .bind(exempt.id.to_string())
    .fetch_one(&owner)
    .await
    .unwrap();
    assert_eq!(
        answer_events, 3,
        "create twice and attach once; rename is not an answer change"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unknown_and_retired_reason_values_are_stable_refusals_with_no_row(owner: PgPool) {
    let (store, actor) = tenant(&owner, Uuid::new_v4(), "registration-reason-refusal").await;
    let entity = store
        .create_entity(&cmd(&actor), corporation("주식회사 가나", "000211-0006241"))
        .await
        .unwrap()
        .record
        .id;
    for (code_value, version, refusal) in [
        ("NO_SUCH_REASON", "2026-10-22", "invalid_option"),
        ("VAT_DEPOT", "2026-10-21", "reference_version_retired"),
    ] {
        let mut input = not_registered("거절 대상", false);
        input.input.not_registered_reason = Some(CodeInput {
            code: Some(code_value.into()),
            version: Some(version.into()),
        });
        let error = store
            .create_workplace(&cmd(&actor), entity, input, port())
            .await
            .unwrap_err();
        assert_eq!(
            code(error).1,
            vec![("not_registered_reason".into(), refusal)]
        );
    }
    let rows: i64 =
        sqlx::query_scalar("SELECT count(*) FROM workplaces WHERE legal_entity_id = $1")
            .bind(entity)
            .fetch_one(&owner)
            .await
            .unwrap();
    assert_eq!(rows, 0);
}
