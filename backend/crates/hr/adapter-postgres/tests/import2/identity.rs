//! 사번 identifies; an RRN is review evidence, and contradictions block import.

use console_hr_domain::import::plan::IdentityPick;
use sqlx::PgPool;

use crate::harness::{decisions, importer, table};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_later_file_reviews_rrn_candidates_and_questions_contradictions(pool: PgPool) {
    let i = importer(pool).await;
    let header: &[&str] = &["사번", "성명", "주민번호", "입사일"];
    let first: &[&str] = &["1001", "김가", "900101-1234567", "2024-03-04"];
    let first = table("명부", 0, &[header, first]);
    i.load("first.xlsx", &[first], decisions()).await;
    let (kim, _, _) = i.person("김가").await;
    let rrn: &[&str] = &["", "김가", "9001011234567", "2024-03-04"];
    let wrong: &[&str] = &["1001", "김가", "900202-1234568", "2024-03-04"];
    let second = table("명부", 0, &[header, rrn, wrong]);
    let run = i
        .preview("second.xlsx", &[second], &Default::default())
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.rows[0].matched_by, None);
    assert_eq!(plan.rows[0].employee_id, None);
    assert_eq!(plan.rows[0].outcome, "unresolved_identity");
    assert_eq!(plan.rows[0].candidates[0].employee_id, kim);
    assert_eq!(plan.rows[0].candidates[0].basis, "rrn");
    assert_eq!(
        (plan.rows[1].refusal_code, plan.rows[1].refusal_field),
        (Some("identity_mismatch"), Some("rrn"))
    );
    let items = plan.review.items;
    let item = items
        .iter()
        .find(|item| item.reason == "identity_mismatch")
        .unwrap();
    assert!(item.blocking);
    assert_eq!(item.cell.as_deref(), Some("C3"));
    let mut picked = decisions();
    picked.identity.insert(
        plan.rows[0].source_key.clone(),
        IdentityPick {
            employee_id: Some(kim),
        },
    );
    let picked = i.dry_run(run, picked).await;
    assert_eq!(picked.rows[0].matched_by, Some("pick"));
    assert_eq!(picked.rows[0].employee_id, Some(kim));
    assert_eq!(picked.rows[0].outcome, "unchanged");
}
