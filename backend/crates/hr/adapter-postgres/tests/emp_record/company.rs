//! MR-33 company sections (어학, 포상, 징계, 가족) end to end, and the 0262
//! CHECK backstops for any writer that skips the domain.

use console_hr_adapter_postgres::record::{
    CreateRecordRequest, ImportRow, ImportSheetRequest, UpdateRecordRequest,
};
use console_hr_domain::record::{RecordFields, Section};
use serde_json::json;
use sqlx::PgPool;
use uuid::Uuid;

use crate::fixture::fixture;

fn create(fields: serde_json::Value) -> CreateRecordRequest {
    CreateRecordRequest { fields }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn company_sections_record_correct_and_import(pool: PgPool) {
    let f = fixture(pool).await;
    let p = || f.principal.clone();
    let emp = f.employee("C-1").await;
    let lang =
        json!({ "language": "EN", "test": "TOEIC", "score": "905", "taken_on": "2025-05-10" });
    let (row, created) =
        f.hr.create_record(p(), emp, Section::Language, Uuid::new_v4(), create(lang))
            .await
            .unwrap();
    assert!(created);
    let RecordFields::Language(v) = &row.fields else {
        panic!("section changed")
    };
    assert_eq!(v.language, "en");
    let award =
        json!({ "title": "우수사원 표창", "decided_on": "2025-12-01", "issuer": "대표이사" });
    f.hr.create_record(p(), emp, Section::Award, Uuid::new_v4(), create(award))
        .await
        .unwrap();
    let family = json!({ "relation": "SPOUSE", "name": "이가족", "cohabiting": true });
    let (fam, _) =
        f.hr.create_record(p(), emp, Section::Family, Uuid::new_v4(), create(family))
            .await
            .unwrap();
    let corrected = UpdateRecordRequest {
        expected_version: 1,
        fields: json!({ "relation": "SPOUSE", "name": "이가족", "birth_date": "1990-02-03", "cohabiting": true }),
        reason: None,
    };
    let (fam2, _) =
        f.hr.update_record(p(), emp, Section::Family, fam.id, Uuid::new_v4(), corrected)
            .await
            .unwrap();
    assert_eq!(fam2.version, 2);
    let rrn = json!({ "relation": "CHILD", "name": "자녀 200101-3234567" });
    let refused =
        f.hr.create_record(p(), emp, Section::Family, Uuid::new_v4(), create(rrn))
            .await
            .unwrap_err();
    assert_eq!(refused.status, 422);
    // 징계 is recorded, but the plain 인사카드 read leaves it out.
    let discipline = json!({ "title": "견책", "decided_on": "2026-01-05" });
    f.hr.create_record(
        p(),
        emp,
        Section::Discipline,
        Uuid::new_v4(),
        create(discipline),
    )
    .await
    .unwrap();
    let list =
        f.hr.employee_records(p(), emp, None, false, None)
            .await
            .unwrap();
    let mut sections: Vec<Section> = list.items.iter().map(|i| i.section).collect();
    sections.sort();
    assert_eq!(
        sections,
        [Section::Language, Section::Award, Section::Family]
    );
    assert_eq!(list.sections.len(), Section::ALL.len());

    // The sheet path: an 어학 row by 사번, then the export round trip.
    let rows = vec![ImportRow {
        row: 2,
        employee_number: "C-1".into(),
        entry_id: None,
        expected_version: None,
        void_reason: None,
        fields: Some(json!({ "language": "ja", "test": "JLPT", "score": "N1" })),
    }];
    let sheet = |digest| ImportSheetRequest {
        rows: rows.clone(),
        plan_digest: digest,
    };
    let preview =
        f.hr.preview_record_import(p(), Section::Language, sheet(None))
            .await
            .unwrap();
    assert_eq!(preview.rows[0].outcome, "CREATE");
    let (applied, _) =
        f.hr.apply_record_import(
            p(),
            Section::Language,
            Uuid::new_v4(),
            sheet(Some(preview.plan_digest)),
        )
        .await
        .unwrap();
    assert!(applied.applied);
    let export =
        f.hr.record_section_sheet(p(), Section::Language, None, None)
            .await
            .unwrap();
    assert_eq!(export.items.len(), 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn the_table_refuses_rows_the_domain_would_refuse(pool: PgPool) {
    let f = fixture(pool).await;
    let emp = f.employee("C-2").await;
    // Mint the person through the service, then write raw rows as the owner.
    f.hr.create_record(
        f.principal.clone(),
        emp,
        Section::Award,
        Uuid::new_v4(),
        create(json!({ "title": "표창", "decided_on": "2025-01-01" })),
    )
    .await
    .unwrap();
    let insert = |section: &'static str, cols: &'static str, vals: &'static str| {
        let sql = format!(
            "WITH e AS (INSERT INTO person_record_entries (org_id, person_id, section, created_by) \
             VALUES ($1, $2, '{section}', $3) RETURNING id) \
             INSERT INTO person_record_revisions (org_id, entry_id, section, version, kind, command_id, \
             payload_digest, source, actor_id, {cols}) \
             SELECT $1, e.id, '{section}', 1, 'CREATE', gen_random_uuid(), $4, 'MANUAL', $3, {vals} FROM e"
        );
        let owner = f.owner.clone();
        let (org, user) = (f.org, f.user);
        async move {
            // Literal fragments from this test only; values are bound.
            sqlx::query(sqlx::AssertSqlSafe(sql))
                .bind(org)
                .bind(emp)
                .bind(user)
                .bind(vec![0_u8; 32])
                .execute(&owner)
                .await
        }
    };
    let ok = insert("LANGUAGE", "lang_language", "'en'").await;
    assert!(ok.is_ok(), "{ok:?}");
    for (section, cols, vals) in [
        ("LANGUAGE", "lang_language", "'english'"),
        (
            "AWARD",
            "rnd_title, rnd_decided_on, rnd_ends_on",
            "'표창', DATE '2025-01-01', DATE '2025-02-01'",
        ),
        (
            "FAMILY",
            "fam_relation, fam_name",
            "'CHILD', '자녀 200101-3234567'",
        ),
        (
            "FAMILY",
            "fam_relation, fam_name, basis, basis_consent_on",
            "'CHILD', '자녀', 'CONSENT', DATE '2026-01-01'",
        ),
        ("DISABILITY", "dis_severity", "'SEVERE'"),
        ("DISABILITY", "dis_severity, basis", "'SEVERE', 'CONSENT'"),
        (
            "DISABILITY",
            "dis_severity, basis, basis_statute",
            "'SEVERE', 'STATUTE', 'VETERAN_EMPLOYMENT'",
        ),
        (
            "VETERAN",
            "vet_target, basis, basis_consent_on, basis_statute",
            "'SELF', 'CONSENT', DATE '2026-01-01', 'VETERAN_EMPLOYMENT'",
        ),
        (
            "EDUCATION",
            "edu_school, edu_level, edu_status, lang_language",
            "'고', 'HIGH_SCHOOL', 'GRADUATED', 'en'",
        ),
    ] {
        assert!(
            insert(section, cols, vals).await.is_err(),
            "{section}: {cols}"
        );
    }
    let statute = insert(
        "DISABILITY",
        "dis_severity, basis, basis_statute",
        "'NON_SEVERE', 'STATUTE', 'DISABLED_EMPLOYMENT'",
    )
    .await;
    assert!(statute.is_ok(), "{statute:?}");
}
