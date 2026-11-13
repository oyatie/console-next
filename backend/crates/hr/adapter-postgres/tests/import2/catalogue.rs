// SPDX-License-Identifier: LicenseRef-Proprietary
use console_hr_domain::import::detect::WorkbookMappingRequest;
use serde_json::Value;
use sqlx::PgPool;
use std::{fs, path::Path};

use crate::harness::{importer, table};

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
