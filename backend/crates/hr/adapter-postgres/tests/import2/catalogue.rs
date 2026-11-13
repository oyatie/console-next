// SPDX-License-Identifier: LicenseRef-Proprietary
use console_hr_domain::import::detect::WorkbookMappingRequest;
use serde_json::Value;
use sqlx::PgPool;
use std::{fs, path::Path};

use crate::harness::{importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn remembered_rrn_exclusion_survives_an_exact_key_preview(pool: PgPool) {
    let i = importer(pool).await;
    let sheets = [table(
        "Synthetic roster",
        0,
        &[
            &["name", "rrn", "phone"],
            &["Synthetic person", "900101-1000000", "01012345678"],
        ],
    )];
    let mapping = serde_json::from_value(serde_json::json!({"sheets": {"Synthetic roster": {
        "header_row": 1, "columns": {"A": "name", "B": null, "C": null}
    }}}))
    .unwrap();
    i.preview_unconfirmed("synthetic.xlsx", &sheets, &mapping)
        .await
        .unwrap();
    let preview = i
        .preview_unconfirmed(
            "synthetic.xlsx",
            &sheets,
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap();
    for column in &preview.sheets[0]["columns"].as_array().unwrap()[1..] {
        assert!(column["target"].is_null());
        assert_eq!(column["source"], "remembered");
    }
    assert_eq!(preview.sealed_identities, 0);
    assert_eq!(
        i.count("SELECT count(*) FROM data_import_row_identities WHERE org_id=$1")
            .await,
        0
    );
    assert_eq!(
        i.count("SELECT count(*) FROM data_import_row_phones WHERE org_id=$1")
            .await,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn unconfirmed_columns_store_no_cells_or_restricted_values_at_preview(pool: PgPool) {
    let i = importer(pool).await;
    let sheets = [table(
        "Synthetic roster",
        0,
        &[
            &["name", "rrn", "phone", "position"],
            &[
                "Synthetic person",
                "900101-1000000",
                "01012345678",
                "Synthetic title",
            ],
        ],
    )];
    let ordinary = [table(
        "Synthetic roster",
        0,
        &[
            &["name", "position"],
            &["Synthetic person", "Synthetic title"],
        ],
    )];
    for sheets in [&sheets[..], &ordinary[..]] {
        for mapping in [
            WorkbookMappingRequest::default(),
            serde_json::from_value(serde_json::json!({
                "sheets": {"Synthetic roster": {"header_row": 1, "columns": {"A": "name"}}}
            }))
            .unwrap(),
        ] {
            let preview = i
                .preview_unconfirmed("synthetic.xlsx", sheets, &mapping)
                .await
                .unwrap();
            assert_eq!(preview.sealed_identities, 0);
            assert_eq!(preview.input_rows, 0);
            assert!(preview.sample_rows.is_empty());
            assert_eq!(preview.sheets_needing_mapping, 1);
            assert_eq!(preview.sheets[0]["status"], "needs_mapping");
            assert_eq!(
                i.count("SELECT count(*) FROM data_import_rows WHERE org_id=$1")
                    .await,
                0
            );
            assert_eq!(
                i.count("SELECT count(*) FROM data_import_row_identities WHERE org_id=$1")
                    .await,
                0
            );
            assert_eq!(
                i.count("SELECT count(*) FROM data_import_row_phones WHERE org_id=$1")
                    .await,
                0
            );
            assert!(
                i.f.hr
                    .import_column_memory(i.f.principal.org_id)
                    .await
                    .unwrap()
                    .is_empty()
            );
        }
    }
    let mapping = serde_json::from_value(serde_json::json!({"sheets": {"Synthetic roster": {
        "header_row": 1, "columns": {"A": "name", "B": "rrn", "C": "phone", "D": "position"}
    }}}))
    .unwrap();
    let preview = i
        .preview_unconfirmed("synthetic.xlsx", &sheets, &mapping)
        .await
        .unwrap();
    assert_eq!(preview.input_rows, 1);
    assert_eq!(preview.sealed_identities, 1);
    assert_eq!(
        i.count("SELECT count(*) FROM data_import_row_phones WHERE org_id=$1")
            .await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn preview_targets_and_column_classifications_follow_the_catalogue(pool: PgPool) {
    let source = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../domain/data/employee.json"),
    )
    .unwrap();
    let catalogue: Value = serde_json::from_str(&source).unwrap();
    let fields = catalogue["fields"].as_array().unwrap();
    let headers: Vec<&str> = fields
        .iter()
        .map(|field| field["target"].as_str().unwrap())
        .collect();
    let values: Vec<&str> = headers.iter().map(|_| "").collect();
    let i = importer(pool).await;
    let preview = i
        .preview(
            "synthetic-roster.xlsx",
            &[table("Synthetic roster", 0, &[&headers, &values])],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap();
    assert_eq!(preview.available_targets, headers);
    assert_eq!(preview.columns.len(), fields.len());
    for column in &preview.columns {
        let field = fields
            .iter()
            .find(|field| field["target"] == column.normalized_header)
            .unwrap();
        assert_eq!(column.target.as_deref(), field["target"].as_str());
        assert_eq!(
            column.classification,
            field["classification"].as_str().unwrap()
        );
    }
}
