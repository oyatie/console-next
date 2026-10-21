//! The per-section import sheet: preview, digest-bound partial apply,
//! replay, re-import as UNCHANGED, and the export round trip.

use console_hr_adapter_postgres::record::{ImportRow, ImportSheetRequest};
use console_hr_domain::record::{RecordFields, RecordSource, Section};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::fixture::{education, fixture};

fn row(n: u32, number: &str, fields: serde_json::Value) -> ImportRow {
    ImportRow {
        row: n,
        employee_number: number.into(),
        entry_id: None,
        expected_version: None,
        void_reason: None,
        fields: Some(fields),
    }
}

fn sheet(rows: Vec<ImportRow>, digest: Option<String>) -> ImportSheetRequest {
    ImportSheetRequest {
        rows,
        plan_digest: digest,
    }
}

fn outcomes(
    report: &console_hr_adapter_postgres::record::ImportReport,
) -> Vec<(String, Option<String>)> {
    report
        .rows
        .iter()
        .map(|r| (r.outcome.clone(), r.code.clone()))
        .collect()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn sheet_previews_applies_partially_replays_and_reimports_unchanged(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    let s = Section::Education;
    let e1 = f.employee("E1").await;
    f.employee("E2").await;
    f.employee("DUP").await;
    f.legacy_duplicate("DUP").await;
    let rows = vec![
        row(2, " E1 ", education("한국대학교")),
        row(3, "E2", json!({ "school": "x" })),
        row(4, "NOPE", education("a")),
        row(5, "DUP", education("b")),
        row(6, "E1", education("한국대학교")),
    ];
    let preview =
        f.hr.preview_record_import(p(), s, sheet(rows.clone(), None))
            .await
            .unwrap();
    let expected = [
        ("CREATE", None),
        ("ERROR", Some("invalid_fields")),
        ("ERROR", Some("employee_not_found")),
        ("ERROR", Some("employee_number_ambiguous")),
        ("ERROR", Some("duplicate_in_sheet")),
    ];
    let expected: Vec<(String, Option<String>)> = expected
        .iter()
        .map(|(o, c)| ((*o).to_owned(), c.map(str::to_owned)))
        .collect();
    assert_eq!(outcomes(&preview), expected);
    assert_eq!(
        f.count("SELECT count(*) FROM person_record_entries WHERE org_id = $1")
            .await,
        0,
        "preview writes nothing"
    );

    let key = Uuid::new_v4();
    let stale =
        f.hr.apply_record_import(p(), s, key, sheet(rows.clone(), Some("00".repeat(32))))
            .await
            .unwrap_err();
    assert_eq!(stale.code, "record_import_plan_changed");
    let (applied, created) =
        f.hr.apply_record_import(
            p(),
            s,
            key,
            sheet(rows.clone(), Some(preview.plan_digest.clone())),
        )
        .await
        .unwrap();
    assert!(created && applied.applied);
    assert_eq!(
        f.count("SELECT count(*) FROM person_record_entries WHERE org_id = $1")
            .await,
        1
    );
    let (replayed, created) =
        f.hr.apply_record_import(
            p(),
            s,
            key,
            sheet(rows.clone(), Some(preview.plan_digest.clone())),
        )
        .await
        .unwrap();
    assert!(!created && replayed == applied);

    let again =
        f.hr.preview_record_import(p(), s, sheet(rows[..1].to_vec(), None))
            .await
            .unwrap();
    assert_eq!(again.rows[0].outcome, "UNCHANGED");
    let list =
        f.hr.employee_records(p(), e1, Some(s), false, None)
            .await
            .unwrap();
    assert_eq!(list.items[0].source, RecordSource::Import);
    let batches = f.count("SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'employee.record.import_batch'").await;
    assert_eq!(batches, 1);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exported_sheet_comes_back_as_corrections_and_voids(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    let s = Section::Education;
    let e1 = f.employee("E1").await;
    f.employee("E2").await;
    let seed = vec![
        row(2, "E1", education("가대학교")),
        row(3, "E2", education("나대학교")),
    ];
    let preview =
        f.hr.preview_record_import(p(), s, sheet(seed.clone(), None))
            .await
            .unwrap();
    f.hr.apply_record_import(
        p(),
        s,
        Uuid::new_v4(),
        sheet(seed, Some(preview.plan_digest)),
    )
    .await
    .unwrap();

    let export =
        f.hr.record_section_sheet(p(), s, None, Some(1))
            .await
            .unwrap();
    assert_eq!(export.items.len(), 1);
    let rest =
        f.hr.record_section_sheet(p(), s, export.next_after, None)
            .await
            .unwrap();
    assert!(rest.next_after.is_none());
    let rows: Vec<ImportRow> = export
        .items
        .iter()
        .chain(&rest.items)
        .enumerate()
        .map(|(i, r)| {
            let number = r.employee_number.clone().unwrap();
            let mut out = row(i as u32 + 2, &number, education("고친대학교"));
            out.entry_id = Some(r.entry.id);
            out.expected_version = Some(r.entry.version);
            if number == "E2" {
                out.fields = None;
                out.void_reason = Some("잘못 들어온 행".into());
            }
            out
        })
        .collect();
    let preview =
        f.hr.preview_record_import(p(), s, sheet(rows.clone(), None))
            .await
            .unwrap();
    let mut seen: Vec<String> = preview.rows.iter().map(|r| r.outcome.clone()).collect();
    seen.sort();
    assert_eq!(seen, ["UPDATE", "VOID"]);
    f.hr.apply_record_import(
        p(),
        s,
        Uuid::new_v4(),
        sheet(rows, Some(preview.plan_digest)),
    )
    .await
    .unwrap();
    let list =
        f.hr.employee_records(p(), e1, Some(s), false, None)
            .await
            .unwrap();
    let RecordFields::Education(fixed) = &list.items[0].fields else {
        panic!("section changed")
    };
    assert_eq!(
        (list.items[0].version, fixed.school.as_str()),
        (2, "고친대학교")
    );
    assert_eq!(
        f.hr.record_section_sheet(p(), s, None, None)
            .await
            .unwrap()
            .items
            .len(),
        1,
        "the voided entry leaves the sheet"
    );

    f.switch_off("hr.record.education.enabled").await;
    let off =
        f.hr.preview_record_import(p(), s, sheet(vec![row(2, "E1", education("x"))], None))
            .await
            .unwrap_err();
    assert_eq!(off.code, "record_section_disabled");
    // A voids-only sheet still runs with the section off (bulk parity with void).
    let mut void = row(2, "E1", education("x"));
    void.fields = None;
    void.entry_id = Some(list.items[0].id);
    void.expected_version = Some(2);
    void.void_reason = Some("수집 중단".into());
    let voids =
        f.hr.preview_record_import(p(), s, sheet(vec![void], None))
            .await
            .unwrap();
    assert_eq!(voids.rows[0].outcome, "VOID");
}
