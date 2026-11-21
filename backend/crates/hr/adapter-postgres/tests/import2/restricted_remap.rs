// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]

use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
use serde_json::json;
use sqlx::PgPool;

use crate::harness::{decisions, grid, importer, map};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn restricted_column_remap_refused_and_dry_run_apply_block_poisoned_profile(pool: PgPool) {
    use console_hr_domain::import::classification::employee_import_field_for_target;
    let i = importer(pool.clone()).await;
    let name = employee_import_field_for_target("name").unwrap().aliases[0];
    let account = "account_no";
    let salary = "salary";
    let mobile = employee_import_field_for_target("phone").unwrap().aliases[0];
    let sheet = grid(
        "Sheet1",
        &[
            (0, 0, name),
            (0, 1, account),
            (0, 2, salary),
            (0, 3, mobile),
            (1, 0, "Kim Restricted"),
            (1, 1, "110-999-888777"),
            (1, 2, "4500000"),
            (1, 3, "010-2222-3333"),
        ],
    );

    for (col, target) in [("B", "position"), ("C", "job"), ("D", "worksite_name")] {
        let mapping = WorkbookMappingRequest {
            sheets: map(&[(
                "Sheet1",
                SheetMappingRequest {
                    header_row: Some(1),
                    columns: map(&[
                        ("A", Some("name".to_owned())),
                        (col, Some(target.to_owned())),
                    ]),
                    skip: Some(false),
                },
            )]),
        };
        let err = i
            .preview_unconfirmed("remap.xlsx", std::slice::from_ref(&sheet), &mapping)
            .await
            .unwrap_err();
        assert_eq!(err.code, "mapping_restricted_column");
        assert!(!err.message.contains("110-999-888777"));
        assert!(!err.message.contains("4500000"));
        assert!(!err.message.contains("010-2222-3333"));
    }

    let run_count: i64 = sqlx::query_scalar("SELECT count(*) FROM data_import_runs")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(run_count, 0);
    let mem_count: i64 = sqlx::query_scalar("SELECT count(*) FROM import_column_memory")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(mem_count, 0);

    // Legitimate preview with restricted phone target + ignored account/salary succeeds.
    let valid_mapping = WorkbookMappingRequest {
        sheets: map(&[(
            "Sheet1",
            SheetMappingRequest {
                header_row: Some(1),
                columns: map(&[
                    ("A", Some("name".to_owned())),
                    ("B", None),
                    ("C", None),
                    ("D", Some("phone".to_owned())),
                ]),
                skip: Some(false),
            },
        )]),
    };
    let ok_preview = i
        .preview_unconfirmed("valid.xlsx", &[sheet], &valid_mapping)
        .await
        .unwrap();
    assert!(ok_preview.columns.iter().all(|c| {
        if c.normalized_header == account || c.normalized_header == salary {
            c.classification == "restricted" && !c.preview_allowed && c.target.is_none()
        } else {
            true
        }
    }));

    // Defense-in-depth: a pre-existing poisoned mapping_profile is refused in dry-run and apply.
    let poisoned_profile = json!({
        "columns": [
            { "source_header": account, "normalized_header": account, "target": "position" }
        ]
    });
    sqlx::query("UPDATE data_import_runs SET mapping_profile = $2 WHERE id = $1")
        .bind(ok_preview.run_id)
        .bind(&poisoned_profile)
        .execute(&pool)
        .await
        .unwrap();

    let dry_err =
        i.f.hr
            .dry_run_import(
                i.f.principal.clone(),
                ok_preview.run_id,
                console_hr_adapter_postgres::import::types::ImportDryRunRequest {
                    decisions: decisions(),
                },
            )
            .await
            .unwrap_err();
    assert_eq!(dry_err.code, "mapping_restricted_column");

    let digest = "c".repeat(64);
    sqlx::query(
        "UPDATE data_import_runs SET status = 'DRY_RUN', dry_run_digest = $2, \
         dry_run_decisions = '{}'::jsonb, dry_run_summary = '{\"rows\":[]}'::jsonb WHERE id = $1",
    )
    .bind(ok_preview.run_id)
    .bind(&digest)
    .execute(&pool)
    .await
    .unwrap();
    let apply_err = i.apply(ok_preview.run_id, &digest).await.unwrap_err();
    assert_eq!(apply_err.code, "mapping_restricted_column");

    // Poisoned memory row in DB is ignored when loading tenant memory.
    sqlx::query(
        "INSERT INTO import_column_memory (org_id, header_key, target, updated_by) \
         VALUES ($1, $2, 'position', $3) ON CONFLICT (org_id, header_key) DO UPDATE SET target = 'position'",
    )
    .bind(i.org())
    .bind(account)
    .bind(*i.f.principal.user_id.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let loaded =
        i.f.hr
            .import_column_memory(i.f.principal.org_id)
            .await
            .unwrap();
    assert!(!loaded.contains_key(account));
}
