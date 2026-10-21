//! MR-35 (and 징계, MR-33): the restricted sections. Off by default for
//! 장애·보훈 (PIPA §23①), a basis on every revision, left out of the plain
//! read, read only with a purpose (audited, value-free), never exported as a
//! sheet, and never handled on one's own record.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::record::{
    CreateRecordRequest, ImportRow, ImportSheetRequest, RecordPurpose, VoidRecordRequest,
};
use console_hr_domain::record::{Basis, BasisStatute, RecordFields, Section, VeteranTarget};
use console_kernel_core::BranchScope;
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::fixture::{education, fixture};

fn create(fields: serde_json::Value) -> CreateRecordRequest {
    CreateRecordRequest { fields }
}

fn disability() -> CreateRecordRequest {
    create(json!({ "severity": "SEVERE", "recognised_on": "2019-04-01",
        "basis": { "kind": "CONSENT", "consent_on": "2026-09-30" } }))
}

pub(crate) fn purpose(code: &str) -> Option<RecordPurpose> {
    Some(RecordPurpose {
        code: code.into(),
        note: None,
    })
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn disability_and_veteran_start_switched_off(pool: PgPool) {
    let f = fixture(pool).await;
    let emp = f.employee("R-0").await;
    let veteran = || {
        create(json!({ "target": "SELF",
            "basis": { "kind": "STATUTE", "statute": "VETERAN_EMPLOYMENT" } }))
    };
    for (section, body) in [
        (Section::Disability, disability()),
        (Section::Veteran, veteran()),
    ] {
        let err =
            f.hr.create_record(f.principal.clone(), emp, section, Uuid::new_v4(), body)
                .await
                .unwrap_err();
        assert_eq!(
            (err.status.as_u16(), err.code),
            (409, "record_section_disabled")
        );
    }
    let list =
        f.hr.employee_records(f.principal.clone(), emp, None, false, None)
            .await
            .unwrap();
    let off: Vec<Section> = list
        .sections
        .iter()
        .filter(|s| !s.enabled)
        .map(|s| s.section)
        .collect();
    assert_eq!(off, [Section::Disability, Section::Veteran]);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn restricted_entries_are_read_only_with_a_purpose_and_audited(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    f.switch_on("hr.record.disability.enabled").await;
    f.switch_on("hr.record.veteran.enabled").await;
    let emp = f.employee("R-1").await;
    let (row, created) =
        f.hr.create_record(p(), emp, Section::Disability, Uuid::new_v4(), disability())
            .await
            .unwrap();
    assert!(created && row.version == 1);
    let again =
        f.hr.create_record(p(), emp, Section::Disability, Uuid::new_v4(), disability())
            .await
            .unwrap_err();
    assert_eq!(again.code, "record_single_entry_exists");
    f.hr.create_record(
        p(),
        emp,
        Section::Education,
        Uuid::new_v4(),
        create(education("고")),
    )
    .await
    .unwrap();

    // The plain read does not show that a 장애 record exists.
    let plain =
        f.hr.employee_records(p(), emp, None, false, None)
            .await
            .unwrap();
    assert_eq!(plain.items.len(), 1);
    assert_eq!(plain.items[0].section, Section::Education);

    let read = |purpose| {
        f.hr.employee_records(p(), emp, Some(Section::Disability), false, purpose)
    };
    let codes = [
        (None, 422, "record_purpose_required"),
        (purpose("CURIOSITY"), 422, "reason_code_invalid"),
        (purpose("OTHER"), 422, "reason_note_required"),
    ];
    for (purpose, status, code) in codes {
        let err = read(purpose).await.unwrap_err();
        assert_eq!((err.status.as_u16(), err.code), (status, code));
    }
    let seen = read(purpose("STATUTORY_REPORTING")).await.unwrap();
    assert_eq!(
        seen.items.iter().map(|i| i.id).collect::<Vec<_>>(),
        [row.id]
    );
    // 보훈 round-trips its typed columns and basis through the service.
    let veteran = create(json!({ "target": "SELF", "recognised_on": "2001-06-25",
        "basis": { "kind": "STATUTE", "statute": "VETERAN_EMPLOYMENT" } }));
    let (vet, _) =
        f.hr.create_record(p(), emp, Section::Veteran, Uuid::new_v4(), veteran)
            .await
            .unwrap();
    let vets =
        f.hr.employee_records(
            p(),
            emp,
            Some(Section::Veteran),
            false,
            purpose("STATUTORY_REPORTING"),
        )
        .await
        .unwrap();
    let [only] = vets.items.as_slice() else {
        panic!("one 보훈 entry")
    };
    let RecordFields::Veteran(v) = &only.fields else {
        panic!("section changed")
    };
    assert_eq!(only.id, vet.id);
    assert_eq!(v.target, VeteranTarget::SelfHolder);
    assert_eq!(
        v.basis,
        Basis::Statute {
            statute: BasisStatute::VeteranEmployment
        }
    );
    let history =
        f.hr.record_history(
            p(),
            emp,
            Section::Disability,
            row.id,
            purpose("RECORD_CORRECTION"),
        )
        .await
        .unwrap();
    assert_eq!(history.revisions.len(), 1);
    let unpurposed =
        f.hr.record_history(p(), emp, Section::Disability, row.id, None)
            .await
            .unwrap_err();
    assert_eq!(unpurposed.code, "record_purpose_required");

    // One audit row per read: subject, section, entries and purpose; no values.
    let audits: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id = $1 \
         AND action = 'employee.record.restricted_read' ORDER BY occurred_at",
    )
    .bind(f.org)
    .fetch_all(&f.owner)
    .await
    .unwrap();
    assert_eq!(audits.len(), 3);
    assert_eq!(audits[0]["purpose_code"], "STATUTORY_REPORTING");
    assert_eq!(audits[0]["entry_ids"], json!([row.id]));
    let text = serde_json::to_string(&audits).unwrap();
    assert!(
        !text.contains("SEVERE") && !text.contains("2019-04-01") && !text.contains("2001-06-25")
    );

    // No sheet export of a restricted section.
    let export =
        f.hr.record_section_sheet(p(), Section::Disability, None, None)
            .await
            .unwrap_err();
    assert_eq!(export.code, "record_restricted_export_unavailable");

    // Switched off: no new 장애 data, but the entry can still be voided.
    f.switch_off("hr.record.disability.enabled").await;
    let (voided, _) =
        f.hr.void_record(
            p(),
            emp,
            Section::Disability,
            row.id,
            Uuid::new_v4(),
            VoidRecordRequest {
                expected_version: 1,
                reason: "동의 철회".into(),
            },
        )
        .await
        .unwrap();
    assert!(voided.voided);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn nobody_handles_a_restricted_section_of_their_own_record(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    f.switch_on("hr.record.disability.enabled").await;
    let own = f.employee("R-SELF").await;
    let other = f.employee("R-2").await;
    sqlx::query("UPDATE users SET employee_id = $1 WHERE id = $2")
        .bind(own)
        .bind(f.user)
        .execute(&f.owner)
        .await
        .unwrap();
    let err =
        f.hr.create_record(p(), own, Section::Disability, Uuid::new_v4(), disability())
            .await
            .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (403, "record_restricted_self")
    );
    let err =
        f.hr.employee_records(
            p(),
            own,
            Some(Section::Discipline),
            false,
            purpose("DATA_SUBJECT_ACCESS"),
        )
        .await
        .unwrap_err();
    assert_eq!(err.code, "record_restricted_self");
    // Ordinary sections of one's own record meet the platform self rule
    // instead (people-self-33): 403 own_record_forbidden.
    let err =
        f.hr.create_record(
            p(),
            own,
            Section::Education,
            Uuid::new_v4(),
            create(education("고")),
        )
        .await
        .unwrap_err();
    assert_eq!(
        (err.status.as_u16(), err.code),
        (403, "own_record_forbidden")
    );

    // The sheet decides each row for its own subject.
    let row = |n, number: &str| ImportRow {
        row: n,
        employee_number: number.into(),
        entry_id: None,
        expected_version: None,
        void_reason: None,
        fields: Some(json!({ "severity": "NON_SEVERE",
            "basis": { "kind": "STATUTE", "statute": "DISABLED_EMPLOYMENT" } })),
    };
    let rows = vec![row(2, "R-SELF"), row(3, "R-2")];
    let sheet = |digest| ImportSheetRequest {
        rows: rows.clone(),
        plan_digest: digest,
    };
    let preview =
        f.hr.preview_record_import(p(), Section::Disability, sheet(None))
            .await
            .unwrap();
    let got: Vec<_> = preview
        .rows
        .iter()
        .map(|r| (r.outcome.as_str(), r.code.as_deref()))
        .collect();
    assert_eq!(
        got,
        [("ERROR", Some("restricted_denied")), ("CREATE", None)]
    );
    f.hr.apply_record_import(
        p(),
        Section::Disability,
        Uuid::new_v4(),
        sheet(Some(preview.plan_digest)),
    )
    .await
    .unwrap();
    let seen =
        f.hr.employee_records(
            p(),
            other,
            Some(Section::Disability),
            false,
            purpose("STATUTORY_REPORTING"),
        )
        .await
        .unwrap();
    assert_eq!(seen.items.len(), 1);
}
