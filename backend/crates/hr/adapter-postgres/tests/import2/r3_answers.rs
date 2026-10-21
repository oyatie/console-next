//! UX-R3 IMPORT r3:hire-19: a conflict pattern takes one answer
//! (`group_answers`); an answer the pattern does not have is refused.

use std::collections::BTreeMap;

use console_hr_domain::import::detect::WorkbookMappingRequest;
use sqlx::PgPool;

use crate::harness::{decisions, importer, table};

/// 재직 with a future 입사일: refused until answered 「입사 예정으로」, then the
/// person comes in 입사 예정; a made-up answer is 422 and nothing changes.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_active_with_a_future_hire_date_is_answered_pre_hire_once(pool: PgPool) {
    let i = importer(pool).await;
    let rows: &[&[&str]] = &[
        &["사번", "성명", "입사일", "재직상태"],
        &["P-1", "고미래", "2099-03-02", "재직"],
        &["P-2", "나미래", "2099-04-01", "재직"],
    ];
    let run = i
        .preview(
            "명부.xlsx",
            &[table("명부", 0, rows)],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let refused = i.dry_run(run, decisions()).await;
    assert!(
        refused
            .rows
            .iter()
            .all(|r| r.refusal_code == Some("status_conflict")),
        "{:?}",
        refused.rows
    );

    let mut wrong = decisions();
    wrong.group_answers = BTreeMap::from([("status_conflict".into(), "guess".into())]);
    let error = i.try_dry_run(run, wrong).await.unwrap_err();
    assert_eq!((error.status.as_u16(), error.code), (422, "validation"));
    let mut unknown = decisions();
    unknown.group_answers = BTreeMap::from([("identity_conflict".into(), "pre_hire".into())]);
    let error = i.try_dry_run(run, unknown).await.unwrap_err();
    assert_eq!((error.status.as_u16(), error.code), (422, "validation"));

    let mut answer = decisions();
    answer.group_answers = BTreeMap::from([("status_conflict".into(), "pre_hire".into())]);
    let plan = i.dry_run(run, answer).await;
    assert_eq!(plan.insert_candidates, 2);
    i.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!(
        i.count(
            "SELECT count(*) FROM employees WHERE org_id = $1 AND employment_status = 'PRE_HIRE'"
        )
        .await,
        2
    );
}
