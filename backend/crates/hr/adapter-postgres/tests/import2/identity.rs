//! Matching order: 사번, then the RRN hash; a contradiction is a question.

use sqlx::PgPool;

use crate::harness::{decisions, importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_later_file_finds_people_by_rrn_and_questions_contradictions(pool: PgPool) {
    let i = importer(pool).await;
    let header: &[&str] = &["사번", "성명", "주민번호", "입사일"];
    i.load(
        "first.xlsx",
        &[table(
            "명부",
            0,
            &[header, &["1001", "김가", "900101-1234567", "2024-03-04"]],
        )],
        decisions(),
    )
    .await;
    let (kim, _, _) = i.person("김가").await;
    let second = table(
        "명부",
        0,
        &[
            header,
            &["", "김가", "9001011234567", "2024-03-04"],
            &["1001", "김가", "900202-1234568", "2024-03-04"],
        ],
    );
    let run = i
        .preview("second.xlsx", &[second], &Default::default())
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.rows[0].matched_by, Some("rrn"));
    assert_eq!(plan.rows[0].employee_id, Some(kim));
    assert_eq!(plan.rows[0].outcome, "unchanged");
    assert_eq!(
        (plan.rows[1].refusal_code, plan.rows[1].refusal_field),
        (Some("identity_mismatch"), Some("rrn"))
    );
    let item = plan
        .review
        .items
        .iter()
        .find(|item| item.reason == "identity_mismatch")
        .unwrap();
    assert!(item.blocking);
    assert_eq!(item.cell.as_deref(), Some("C3"));
}
