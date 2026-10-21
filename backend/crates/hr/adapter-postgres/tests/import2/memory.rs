//! What the operator mapped once — a header label, a 재직상태 text — is
//! offered again on the next file.

use console_hr_domain::import::detect::{SheetMappingRequest, WorkbookMappingRequest};
use sqlx::PgPool;

use crate::harness::{decisions, importer, map, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn mapped_labels_and_values_are_remembered_per_tenant(pool: PgPool) {
    let i = importer(pool).await;
    let file = || {
        vec![table(
            "인원",
            0,
            &[
                &["직원", "입사일", "재직상태"],
                &["가나", "2024-01-02", "파견"],
            ],
        )]
    };
    let mapping = WorkbookMappingRequest {
        sheets: map(&[(
            "인원",
            SheetMappingRequest {
                header_row: Some(1),
                columns: map(&[("A", Some("name".to_owned()))]),
                skip: Some(false),
            },
        )]),
    };
    let run = i.preview("a.xlsx", &file(), &mapping).await.unwrap().run_id;
    let plan = i.dry_run(run, decisions()).await;
    let status = plan
        .review
        .items
        .iter()
        .find(|item| item.reason == "status_unmapped")
        .unwrap();
    assert_eq!(status.resolution.as_ref().unwrap().decision, "status_map");
    let mut answer = decisions();
    answer.status_map = map(&[("파견", "ACTIVE".to_owned())]);
    let plan = i.dry_run(run, answer).await;
    i.apply(run, &plan.dry_run_digest).await.unwrap();

    let again = i
        .preview("b.xlsx", &file(), &Default::default())
        .await
        .unwrap();
    assert_eq!(again.sheets[0]["status"], "mapped");
    assert_eq!(again.sheets[0]["columns"][0]["source"], "remembered");
    let plan = i.dry_run(again.run_id, decisions()).await;
    assert!(
        plan.remembered
            .iter()
            .any(|r| r.decision == "status_map" && r.key == "파견")
    );
    assert!(plan.rows.iter().all(|r| r.refusal_code.is_none()));
}
