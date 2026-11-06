// SPDX-License-Identifier: LicenseRef-Proprietary
//! Restricted cell spellings stay out of plain import storage and labels.

use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::rrn_value::Rrn;
use serde_json::Value;
use sqlx::PgPool;

use crate::harness::{importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn accepted_rrn_spellings_are_dropped_before_storage(pool: PgPool) {
    let i = importer(pool).await;
    let digits = "9001011234567";
    for at in 0..=digits.len() {
        let cell = format!("{}-{}", &digits[..at], &digits[at..]);
        assert!(Rrn::parse(&cell).is_ok());
        let sheet = table(
            "명부",
            0,
            &[
                &["사번", "성명", "비고", &cell],
                &["1001", "김가", &cell, "참고"],
                &["1002", &cell, "참고", ""],
            ],
        );
        let preview = i
            .preview("people.xlsx", &[sheet], &WorkbookMappingRequest::default())
            .await
            .unwrap();
        let rows: Vec<(Value, Value)> =
            sqlx::query_as("SELECT raw_row, canonical_row FROM data_import_rows WHERE run_id = $1")
                .bind(preview.run_id)
                .fetch_all(&i.owner)
                .await
                .unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows.iter().filter(|row| row.1["name"].is_string()).count(),
            1
        );
        for row in rows {
            assert!(!serde_json::to_string(&row).unwrap().contains(&cell));
        }
        let mapping: Value =
            sqlx::query_scalar("SELECT mapping_profile FROM data_import_runs WHERE id = $1")
                .bind(preview.run_id)
                .fetch_one(&i.owner)
                .await
                .unwrap();
        assert!(!mapping.to_string().contains(&cell));
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn accepted_rrn_sheet_labels_are_refused_without_a_run(pool: PgPool) {
    let i = importer(pool).await;
    let digits = "9001011234567";
    for at in 0..=digits.len() {
        let label = format!("{}-{}", &digits[..at], &digits[at..]);
        let sheet = table(&label, 0, &[&["사번", "성명"], &["1001", "김가"]]);
        let error = i
            .preview("people.xlsx", &[sheet], &WorkbookMappingRequest::default())
            .await
            .unwrap_err();
        assert_eq!((error.status.as_u16(), error.code), (422, "validation"));
    }
    assert_eq!(
        i.count("SELECT count(*) FROM data_import_runs WHERE org_id = $1")
            .await,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn mapped_columns_drop_restricted_values_before_canonical_storage(pool: PgPool) {
    use console_hr_domain::import::detect::SheetMappingRequest;
    use console_hr_domain::import::fields::EMPLOYEE_IMPORT_FIELD_DEFINITIONS;
    let i = importer(pool).await;
    let mut spellings = vec![
        "9001011234567.0".to_owned(),
        "900101 1234567".into(),
        "900101–1234567".into(),
        "９００１０１－１２３４５６７".into(),
        "５０１０１３２３４５６７．０".into(),
        "확인 900101-1234567".into(),
        "1 900101-1234567 2".into(),
        "1 900101 1234567 2".into(),
        "1 ９００１０１－１２３４５６７ 2".into(),
    ];
    let digits = "9001011234567";
    for at in 0..=digits.len() {
        spellings.push(format!("{}-{}", &digits[..at], &digits[at..]));
    }
    let fields = EMPLOYEE_IMPORT_FIELD_DEFINITIONS
        .iter()
        .filter(|f| !matches!(f.target, "rrn" | "name"))
        .chain(
            EMPLOYEE_IMPORT_FIELD_DEFINITIONS
                .iter()
                .filter(|f| f.target == "name"),
        );
    for field in fields {
        for cell in &spellings {
            let sheet = table("명부", 0, &[&["성명", "입력"], &["김가", cell]]);
            let mapping = WorkbookMappingRequest {
                sheets: [(
                    "명부".into(),
                    SheetMappingRequest {
                        header_row: Some(1),
                        columns: [
                            ("A".into(), (field.target != "name").then(|| "name".into())),
                            ("B".into(), Some(field.target.into())),
                        ]
                        .into(),
                        ..Default::default()
                    },
                )]
                .into(),
            };
            let preview = i.preview("people.xlsx", &[sheet], &mapping).await.unwrap();
            let rows: Vec<(Value, Value)> = sqlx::query_as(
                "SELECT raw_row, canonical_row FROM data_import_rows WHERE run_id = $1",
            )
            .bind(preview.run_id)
            .fetch_all(&i.owner)
            .await
            .unwrap();
            assert_eq!(rows.len(), 1);
            assert!(
                !rows
                    .iter()
                    .any(|(raw, canonical)| restricted_value(raw) || restricted_value(canonical)),
                "mapped target {} retained a restricted scalar",
                field.target
            );
            if field.target == "phone" {
                let staged: i64 = sqlx::query_scalar(
                    "SELECT count(*) FROM data_import_row_phones WHERE run_id=$1",
                )
                .bind(preview.run_id)
                .fetch_one(&i.owner)
                .await
                .unwrap();
                assert_eq!(
                    staged, 0,
                    "restricted values must not become staged contacts"
                );
            }
            assert!(
                !serde_json::to_string(&rows).unwrap().contains(cell),
                "mapped target {} retained a restricted value",
                field.target
            );
            if field.target != "name" {
                assert!(
                    rows[0].1["source_metadata"]["dropped_restricted_columns"]
                        .as_array()
                        .unwrap()
                        .contains(&serde_json::json!("입력"))
                );
            }
        }
    }
}

fn restricted_value(value: &Value) -> bool {
    use console_hr_domain::import::rrn::is_rrn_value;
    match value {
        Value::String(text) => is_rrn_value(text),
        Value::Number(number) => is_rrn_value(&number.to_string()),
        Value::Array(values) => values.iter().any(restricted_value),
        Value::Object(values) => values
            .iter()
            .any(|(key, value)| is_rrn_value(key) || restricted_value(value)),
        _ => false,
    }
}
