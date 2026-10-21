//! One-by-one create, correct, void, history; PII shapes; the 병역 single
//! entry; the tenant switch; shared persons; access.

use std::collections::BTreeSet;

use console_hr_adapter_postgres::record::{
    CreateRecordRequest, UpdateRecordRequest, VoidRecordRequest,
};
use console_hr_domain::record::{RevisionKind, Section};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::fixture::{education, fixture, military};

fn create(fields: serde_json::Value) -> CreateRecordRequest {
    CreateRecordRequest { fields }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn create_correct_void_keep_history_on_a_minted_person(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    let emp = f.employee("E-1").await;
    let s = Section::Education;
    let key = Uuid::new_v4();
    let (row, created) =
        f.hr.create_record(p(), emp, s, key, create(education("한국대학교")))
            .await
            .unwrap();
    assert!(created && row.version == 1 && !row.voided);
    // The Person was minted through the port: person_id = employee_id.
    let bound: Uuid =
        sqlx::query_scalar("SELECT person_id FROM employee_person_bindings WHERE employee_id = $1")
            .bind(emp)
            .fetch_one(&f.owner)
            .await
            .unwrap();
    assert_eq!(bound, emp);
    let (replay, created) =
        f.hr.create_record(p(), emp, s, key, create(education("한국대학교")))
            .await
            .unwrap();
    assert!(!created && replay.id == row.id);
    let reused =
        f.hr.create_record(p(), emp, s, key, create(education("다른대학교")))
            .await
            .unwrap_err();
    assert_eq!(reused.status, 409);

    let fix = |v| UpdateRecordRequest {
        expected_version: v,
        fields: education("한국대학교 본교"),
        reason: Some("오기 정정".into()),
    };
    let (fixed, _) =
        f.hr.update_record(p(), emp, s, row.id, Uuid::new_v4(), fix(1))
            .await
            .unwrap();
    assert_eq!(fixed.version, 2);
    let stale =
        f.hr.update_record(p(), emp, s, row.id, Uuid::new_v4(), fix(1))
            .await
            .unwrap_err();
    assert_eq!(
        (stale.status.as_u16(), stale.code),
        (409, "record_version_conflict")
    );

    let void = |reason: &str| VoidRecordRequest {
        expected_version: 2,
        reason: reason.into(),
    };
    assert_eq!(
        f.hr.void_record(p(), emp, s, row.id, Uuid::new_v4(), void(" "))
            .await
            .unwrap_err()
            .status,
        422
    );
    let (voided, _) =
        f.hr.void_record(p(), emp, s, row.id, Uuid::new_v4(), void("중복 입력"))
            .await
            .unwrap();
    assert!(voided.voided && voided.version == 3);
    assert_eq!(
        f.hr.update_record(p(), emp, s, row.id, Uuid::new_v4(), fix(3))
            .await
            .unwrap_err()
            .status,
        409
    );

    let live =
        f.hr.employee_records(p(), emp, None, false, None)
            .await
            .unwrap();
    assert!(live.items.is_empty());
    // 장애·보훈 start off (PIPA §23①); every other section starts on.
    assert!(
        live.sections
            .iter()
            .all(|s| s.enabled != matches!(s.section, Section::Disability | Section::Veteran))
    );
    let all =
        f.hr.employee_records(p(), emp, Some(s), true, None)
            .await
            .unwrap();
    assert_eq!(all.items.len(), 1);
    let history =
        f.hr.record_history(p(), emp, s, row.id, None)
            .await
            .unwrap();
    let kinds: Vec<RevisionKind> = history.revisions.iter().map(|r| r.kind).collect();
    assert_eq!(
        kinds,
        [
            RevisionKind::Create,
            RevisionKind::Update,
            RevisionKind::Void
        ]
    );
    assert_eq!(history.revisions[2].reason.as_deref(), Some("중복 입력"));

    // Three audit rows, none carrying a value.
    let audits: Vec<serde_json::Value> = sqlx::query_scalar(
        "SELECT after_snap FROM audit_events WHERE org_id = $1 AND action LIKE 'employee.record.%'",
    )
    .bind(f.org)
    .fetch_all(&f.owner)
    .await
    .unwrap();
    assert_eq!(audits.len(), 3);
    assert!(audits.iter().all(|a| !a.to_string().contains("대학교")));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn identifiers_are_refused_by_the_domain_and_the_table(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    let emp = f.employee("E-2").await;
    let licence =
        json!({ "name": "1종 보통", "kind": "DRIVER_LICENSE", "number": "11-23-456789-01" });
    let err =
        f.hr.create_record(
            p(),
            emp,
            Section::Qualification,
            Uuid::new_v4(),
            create(licence),
        )
        .await
        .unwrap_err();
    assert_eq!(err.status, 422);
    let rrn = education("900101-1234567");
    assert_eq!(
        f.hr.create_record(p(), emp, Section::Education, Uuid::new_v4(), create(rrn))
            .await
            .unwrap_err()
            .status,
        422
    );
    let exemption = json!({ "status": "EXEMPT", "exemption_reason": "x" });
    assert_eq!(
        f.hr.create_record(
            p(),
            emp,
            Section::Military,
            Uuid::new_v4(),
            create(exemption)
        )
        .await
        .unwrap_err()
        .status,
        422
    );

    // The CHECKs hold for any other writer too.
    let ok = json!({ "name": "1종 보통", "kind": "DRIVER_LICENSE" });
    let (row, _) =
        f.hr.create_record(p(), emp, Section::Qualification, Uuid::new_v4(), create(ok))
            .await
            .unwrap();
    for number in ["A-1", "112345678901"] {
        let raw = sqlx::query(
            "INSERT INTO person_record_revisions (org_id, entry_id, section, version, kind, command_id, payload_digest, \
             source, actor_id, qual_name, qual_kind, qual_number) VALUES ($1, $2, 'QUALIFICATION', 2, 'UPDATE', $3, \
             $4, 'MANUAL', $5, '면허', $6, $7)",
        )
        .bind(f.org).bind(row.id).bind(Uuid::new_v4()).bind(vec![0_u8; 32]).bind(f.user)
        .bind(if number == "A-1" { "DRIVER_LICENSE" } else { "OTHER" }).bind(number)
        .execute(&f.owner).await;
        assert!(raw.is_err(), "{number} must be refused by the table");
    }
    let edit =
        sqlx::query("UPDATE person_record_revisions SET qual_name = 'x' WHERE entry_id = $1")
            .bind(row.id)
            .execute(&f.owner)
            .await;
    assert!(edit.is_err(), "revisions are append-only");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn military_is_single_and_a_switched_off_section_still_reads_and_voids(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    let emp = f.employee("E-3").await;
    let m = Section::Military;
    let (row, _) =
        f.hr.create_record(
            p(),
            emp,
            m,
            Uuid::new_v4(),
            create(military("NOT_COMPLETED")),
        )
        .await
        .unwrap();
    let second =
        f.hr.create_record(p(), emp, m, Uuid::new_v4(), create(military("COMPLETED")))
            .await
            .unwrap_err();
    assert_eq!(second.code, "record_single_entry_exists");

    f.switch_off("hr.record.military.enabled").await;
    let fix = UpdateRecordRequest {
        expected_version: 1,
        fields: military("EXEMPT"),
        reason: None,
    };
    let off =
        f.hr.update_record(p(), emp, m, row.id, Uuid::new_v4(), fix)
            .await
            .unwrap_err();
    assert_eq!(
        (off.status.as_u16(), off.code),
        (409, "record_section_disabled")
    );
    f.hr.create_record(p(), emp, Section::Training, Uuid::new_v4(), create(json!({
        "course": "산업안전보건교육", "status": "COMPLETED", "started_on": "2026-01-05", "hours": 8
    }))).await.unwrap();
    let list =
        f.hr.employee_records(p(), emp, None, false, None)
            .await
            .unwrap();
    assert!(list.sections.iter().any(|s| s.section == m && !s.enabled));
    assert_eq!(list.items.len(), 2);
    let void = VoidRecordRequest {
        expected_version: 1,
        reason: "수집 중단".into(),
    };
    assert!(
        f.hr.void_record(p(), emp, m, row.id, Uuid::new_v4(), void)
            .await
            .unwrap()
            .0
            .voided
    );
}
