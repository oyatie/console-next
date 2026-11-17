// SPDX-License-Identifier: LicenseRef-Proprietary
//! Workplace bindings and physical sites remain distinct through import memory.

use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
use console_hr_domain::import::grid::GridSheet;
use sqlx::PgPool;

use crate::harness::{decisions, importer, map, table};

#[allow(dead_code)]
#[path = "../import_home_branch/shared.rs"]
mod shared;

fn staff(values: &[&str], header: &str) -> Vec<GridSheet> {
    let mut lines = vec![vec![
        "사번".into(),
        "성명".into(),
        "입사일".into(),
        "고용형태".into(),
        header.into(),
    ]];
    for (index, value) in values.iter().enumerate() {
        lines.push(vec![
            format!("PLACE-{index}"),
            format!("장소직원{index}"),
            "2024-03-04".into(),
            "REGULAR".into(),
            (*value).into(),
        ]);
    }
    let refs: Vec<Vec<&str>> = lines
        .iter()
        .map(|row| row.iter().map(String::as_str).collect())
        .collect();
    vec![table(
        "명부",
        0,
        &refs.iter().map(Vec::as_slice).collect::<Vec<_>>(),
    )]
}

fn reading(target: &str) -> WorkbookMappingRequest {
    WorkbookMappingRequest {
        sheets: map(&[(
            "명부",
            SheetMappingRequest {
                header_row: Some(1),
                columns: map(&[("E", Some(target.into()))]),
                skip: Some(false),
            },
        )]),
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn place_model_defaults_by_exact_and_normalized_workplace_values(pool: PgPool) {
    let i = importer(pool).await;
    let (_, workplace) = shared::setup_headquarters(&i, i.f.branch).await;
    let preview = i
        .preview(
            "places.xlsx",
            &staff(&["본사", "본 사"], "사업장"),
            &Default::default(),
        )
        .await
        .unwrap();
    let column = preview
        .columns
        .iter()
        .find(|column| column.source_header == "사업장")
        .unwrap();
    assert_eq!(column.target.as_deref(), Some("workplace"));
    assert_eq!(preview.sheets_needing_mapping, 0);
    let plan = i.dry_run(preview.run_id, decisions()).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    assert!(plan.rows.iter().all(|row| {
        row.new_person
            .as_ref()
            .is_some_and(|person| person.workplace_id == Some(workplace))
    }));
    i.apply(preview.run_id, &plan.dry_run_digest).await.unwrap();
    assert_eq!(
        i.count("SELECT count(*) FROM employment_assignments WHERE org_id=$1")
            .await,
        2
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1 AND worksite_name IS NOT NULL")
            .await,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn place_model_confirms_mixed_values_and_reconfirms_remembered_readings_per_tenant(
    pool: PgPool,
) {
    let i = importer(pool.clone()).await;
    shared::setup_headquarters(&i, i.f.branch).await;
    let file = staff(&["본사", "고객고유현장"], "사업장");
    let preview = i
        .preview_unconfirmed("sites.xlsx", &file, &Default::default())
        .await
        .unwrap();
    assert_eq!(preview.sheets_needing_mapping, 1);
    assert!(preview.columns.is_empty());
    assert_eq!(preview.sheets[0]["columns"][4]["target"], "workplace");
    assert!(preview.sample_rows.is_empty());
    let blocked = i.dry_run(preview.run_id, decisions()).await;
    assert_eq!(blocked.review.blocking, 1);
    assert!(blocked.rows.iter().all(|row| {
        row.new_person
            .as_ref()
            .is_none_or(|person| person.workplace_id.is_none())
    }));
    let refused = i
        .apply(preview.run_id, &blocked.dry_run_digest)
        .await
        .unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "import_unresolved")
    );

    let chosen = i
        .preview("sites.xlsx", &file, &reading("worksite_name"))
        .await
        .unwrap();
    assert_eq!(chosen.sheets_needing_mapping, 0);
    let plan = i.dry_run(chosen.run_id, decisions()).await;
    assert_eq!(plan.review.blocking, 0);
    assert!(plan.decisions.workplace_map.is_empty());
    assert!(plan.rows.iter().all(|row| {
        row.new_person
            .as_ref()
            .is_some_and(|person| person.workplace_id.is_none())
    }));
    i.apply(chosen.run_id, &plan.dry_run_digest).await.unwrap();
    assert_eq!(
        i.count("SELECT count(*) FROM employment_assignments WHERE org_id=$1")
            .await,
        0
    );
    assert_eq!(i.count("SELECT count(*) FROM employees WHERE org_id=$1 AND worksite_name IN ('본사','고객고유현장')").await, 2);

    let repeated = i
        .preview_unconfirmed("sites-again.xlsx", &file, &Default::default())
        .await
        .unwrap();
    assert_eq!(repeated.sheets_needing_mapping, 1);
    assert_eq!(repeated.sheets[0]["columns"][4]["target"], "worksite_name");
    assert_eq!(repeated.sheets[0]["columns"][4]["source"], "remembered");
    let confirmed = i
        .preview("sites-again.xlsx", &file, &Default::default())
        .await
        .unwrap();
    assert_eq!(
        i.dry_run(confirmed.run_id, decisions())
            .await
            .review
            .blocking,
        0
    );

    let other = importer(pool).await;
    shared::setup_headquarters(&other, other.f.branch).await;
    let independent = other
        .preview_unconfirmed("sites.xlsx", &file, &Default::default())
        .await
        .unwrap();
    assert_eq!(independent.sheets_needing_mapping, 1);
    assert_eq!(independent.sheets[0]["columns"][4]["source"], "catalog");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn place_model_explicit_unknown_workplace_stays_unplaced_with_a_fix_item(pool: PgPool) {
    let i = importer(pool).await;
    shared::setup_headquarters(&i, i.f.branch).await;
    let preview = i
        .preview(
            "unknown.xlsx",
            &staff(&["없는사업장"], "사업장"),
            &reading("workplace"),
        )
        .await
        .unwrap();
    assert_eq!(preview.sheets_needing_mapping, 0);
    let plan = i.dry_run(preview.run_id, decisions()).await;
    let item = plan
        .review
        .items
        .iter()
        .find(|item| item.reason == "workplace_unmapped")
        .unwrap();
    assert_eq!(item.value.as_deref(), Some("없는사업장"));
    assert_eq!(item.resolution.as_ref().unwrap().decision, "workplace_map");
    assert!(
        plan.rows[0]
            .new_person
            .as_ref()
            .unwrap()
            .workplace_id
            .is_none()
    );
    i.apply(preview.run_id, &plan.dry_run_digest).await.unwrap();
    assert_eq!(
        i.count("SELECT count(*) FROM employment_assignments WHERE org_id=$1")
            .await,
        0
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn place_model_worksite_values_never_recall_workplace_binding_memory(pool: PgPool) {
    let i = importer(pool).await;
    let (_, workplace) = shared::setup_headquarters(&i, i.f.branch).await;
    sqlx::query("INSERT INTO import_value_memory (org_id,field,source_value,mapped,updated_by) VALUES ($1,'workplace','본사',$2,$3)")
        .bind(i.org()).bind(workplace.to_string()).bind(*i.f.principal.user_id.as_uuid())
        .execute(&i.owner).await.unwrap();
    let preview = i
        .preview(
            "physical.xlsx",
            &staff(&["본사"], "근무지"),
            &Default::default(),
        )
        .await
        .unwrap();
    let plan = i.dry_run(preview.run_id, decisions()).await;
    assert!(plan.decisions.workplace_map.is_empty());
    assert!(
        !plan
            .remembered
            .iter()
            .any(|entry| entry.decision == "workplace_map")
    );
    assert!(
        plan.rows[0]
            .new_person
            .as_ref()
            .unwrap()
            .workplace_id
            .is_none()
    );
    i.apply(preview.run_id, &plan.dry_run_digest).await.unwrap();
    assert_eq!(
        i.count("SELECT count(*) FROM employment_assignments WHERE org_id=$1")
            .await,
        0
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1 AND worksite_name='본사'")
            .await,
        1
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn confirmed_mixed_workplaces_resolve_sites_per_value_without_losing_known_placement(
    pool: PgPool,
) {
    let i = importer(pool).await;
    shared::setup_headquarters(&i, i.f.branch).await;
    let file = staff(&["본사", "고객고유현장"], "사업장");
    let unconfirmed = i
        .preview_unconfirmed("mixed.xlsx", &file, &Default::default())
        .await
        .unwrap();
    assert_eq!(unconfirmed.sheets[0]["status"], "needs_mapping");
    assert_eq!(unconfirmed.sheets[0]["needs_confirmation"], true);
    assert_eq!(unconfirmed.sheets[0]["rows"], 2);
    assert!(unconfirmed.columns.is_empty());
    let bound = i
        .preview("mixed.xlsx", &file, &reading("workplace"))
        .await
        .unwrap();
    let unresolved = i.dry_run(bound.run_id, decisions()).await;
    let item = unresolved
        .review
        .items
        .iter()
        .find(|item| item.reason == "workplace_unmapped")
        .unwrap();
    assert_eq!(item.value.as_deref(), Some("고객고유현장"));
    assert_eq!(item.resolution.as_ref().unwrap().decision, "workplace_map");
    let mut answer = decisions();
    answer.workplace_map.insert("고객고유현장".into(), None);
    let resolved = i.dry_run(bound.run_id, answer).await;
    assert!(
        !resolved
            .review
            .items
            .iter()
            .any(|item| item.reason == "workplace_unmapped")
    );
    i.apply(bound.run_id, &resolved.dry_run_digest)
        .await
        .unwrap();
    assert_eq!(
        i.count("SELECT count(*) FROM employment_assignments WHERE org_id=$1")
            .await,
        1
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id=$1")
            .await,
        2
    );
}
