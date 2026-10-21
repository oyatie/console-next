//! BE-MIG (walkthrough W02 W03 W05 W12) on the real dry run and apply:
//! labels the catalog maps, near-miss names offered never bound, group
//! answers, Korean-word dates, the footer row, the phone column, a roster
//! without a pay period. Every guard is asserted refusing with no side effect.

use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::plan::{Decisions, Exclusion};
use sqlx::PgPool;

use crate::harness::{Importer, decisions, importer, map, table};

const HEADER: &[&str] = &["사번", "성명", "입사일", "고용형태", "부서", "연락처"];

async fn staged(i: &Importer, rows: &[&[&str]]) -> uuid::Uuid {
    let all: Vec<&[&str]> = std::iter::once(HEADER)
        .chain(rows.iter().copied())
        .collect();
    i.preview(
        "roster.xlsx",
        &[table("명부", 0, &all)],
        &WorkbookMappingRequest::default(),
    )
    .await
    .unwrap()
    .run_id
}

/// regression (W02, W05, W12): 정규직 needed a pick, 「2011년 4월 10일」 was
/// refused, 연락처 was dropped. Now the label maps (reported), the date reads,
/// and the phone lands on the profile — never in an import row.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_labels_dates_and_phones_land_on_the_profile(pool: PgPool) {
    let i = importer(pool).await;
    let run = staged(
        &i,
        &[
            &[
                "E-1",
                "김정규",
                "2011년 4월 10일",
                "정규직",
                "",
                "010-1234-5678",
            ],
            &["E-2", "이계약", "2020.3.2", "계약", "", "1098765432"],
        ],
    )
    .await;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    let mapped: Vec<_> = plan
        .auto_mapped
        .iter()
        .map(|a| (a.value.as_str(), a.code, a.rows))
        .collect();
    assert_eq!(mapped, [("계약", "CONTRACT", 1), ("정규직", "REGULAR", 1)]);
    assert_eq!(plan.employment_type_empty_rows, 0);
    assert_eq!(plan.phone_unstored_rows, 0);
    i.apply(run, &plan.dry_run_digest).await.unwrap();

    let (kim, _, _) = i.person("김정규").await;
    let profile: (String, Option<String>) = sqlx::query_as(
        "SELECT employment_type, phone_e164 FROM employee_employment_profiles WHERE employee_id = $1",
    )
    .bind(kim)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(profile, ("REGULAR".into(), Some("+821012345678".into())));
    let hired: String = sqlx::query_scalar("SELECT hire_date::TEXT FROM employees WHERE id = $1")
        .bind(kim)
        .fetch_one(&i.owner)
        .await
        .unwrap();
    assert_eq!(hired, "2011-04-10");
    assert_eq!(
        i.count(
            "SELECT count(*) FROM data_import_rows WHERE org_id = $1 \
             AND (raw_row::text ~ '1234.?5678|98765432' OR canonical_row::text ~ '1234.?5678|98765432')"
        )
        .await,
        0,
        "a phone never enters an import row"
    );
    assert_eq!(
        i.count("SELECT count(*) FROM data_import_row_phones WHERE org_id = $1")
            .await,
        0,
        "staged phones are gone once stored"
    );
}

/// W02 guard: a label nobody mapped keeps apply closed (422, nothing
/// written); `null` is an answer and is counted for the apply button.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_unmapped_employment_type_blocks_apply_until_answered(pool: PgPool) {
    let i = importer(pool).await;
    let run = staged(&i, &[&["E-1", "김무기", "2024-03-04", "무기계약", "", ""]]).await;
    let plan = i.dry_run(run, decisions()).await;
    let item = &plan.review.items[0];
    assert_eq!(
        (item.reason, item.blocking),
        ("employment_type_unmapped", true)
    );
    let refused = i.apply(run, &plan.dry_run_digest).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (422, "import_unresolved")
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0
    );
    assert_eq!(
        i.count(
            "SELECT count(*) FROM audit_events WHERE org_id = $1 AND action = 'data_import.apply'"
        )
        .await,
        0
    );

    let answer = Decisions {
        employment_type_map: map(&[("무기계약", None)]),
        ..Decisions::default()
    };
    let plan = i.dry_run(run, answer).await;
    assert_eq!(
        (plan.review.blocking, plan.employment_type_empty_rows),
        (0, 1)
    );
    assert_eq!(
        i.apply(run, &plan.dry_run_digest).await.unwrap().inserted,
        1
    );
}

/// regression (W03): 「영업 2팀」 bound nothing and offered nothing; now the
/// unit is a candidate, the person still comes in 미배치 (counted) until
/// the operator clicks it.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_near_miss_units_are_offered_and_bound_only_on_answer(pool: PgPool) {
    let i = importer(pool).await;
    let sales = i.unit("영업2팀").await;
    let run = staged(
        &i,
        &[&["E-1", "김영업", "2024-03-04", "정규직", "영업 2팀", ""]],
    )
    .await;
    let plan = i.dry_run(run, decisions()).await;
    let item = plan
        .review
        .items
        .iter()
        .find(|item| item.reason == "unit_unmapped")
        .unwrap();
    assert_eq!(item.candidates[0].id, sales);
    assert_eq!(item.candidates[0].basis, "normalized");
    assert_eq!(
        item.resolution.as_ref().unwrap().choices,
        [sales.to_string()]
    );
    let person = plan.rows[0].new_person.as_ref().unwrap();
    assert_eq!(
        person.org_unit_id, None,
        "a candidate is never bound silently"
    );
    assert_eq!(plan.unplaced.rows, 1);
    assert_eq!(plan.unplaced.by_reason["unit_unknown"], 1);

    let answer = Decisions {
        unit_map: map(&[("영업 2팀", Some(sales))]),
        ..Decisions::default()
    };
    let plan = i.dry_run(run, answer).await;
    assert_eq!(
        plan.rows[0].new_person.as_ref().unwrap().org_unit_id,
        Some(sales)
    );
    assert!(!plan.unplaced.by_reason.contains_key("unit_unknown"));
}

/// regression (W05): one answer leaves out every row with the reason; a
/// group key naming no reason is refused and the stored plan is untouched.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_group_answer_excludes_every_row_and_a_bad_key_is_refused(pool: PgPool) {
    let i = importer(pool).await;
    let run = staged(
        &i,
        &[
            &["E-1", "김일", "언젠가", "정규직", "", ""],
            &["E-2", "김이", "모름", "정규직", "", ""],
            &["E-3", "김삼", "2024-03-04", "정규직", "", ""],
        ],
    )
    .await;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.review.groups[0].key, "invalid_date:hire_date");
    assert_eq!(plan.review.groups[0].rows, 2);
    let digest = plan.dry_run_digest;

    let out = || Exclusion {
        reason_code: "OUT_OF_SCOPE".into(),
        note: None,
    };
    let bad = Decisions {
        group_exclusions: map(&[("salary_missing", out())]),
        ..Decisions::default()
    };
    let refused = i.try_dry_run(run, bad).await.unwrap_err();
    assert_eq!((refused.status.as_u16(), refused.code), (422, "validation"));
    let stored: String =
        sqlx::query_scalar("SELECT dry_run_digest FROM data_import_runs WHERE id = $1")
            .bind(run)
            .fetch_one(&i.owner)
            .await
            .unwrap();
    assert_eq!(stored, digest, "a refused dry run stores nothing");

    let group = Decisions {
        group_exclusions: map(&[("invalid_date:hire_date", out())]),
        ..Decisions::default()
    };
    let plan = i.dry_run(run, group).await;
    assert_eq!((plan.excluded_rows, plan.unsettled_rows), (2, 0));
    assert_eq!(
        i.apply(run, &plan.dry_run_digest).await.unwrap().inserted,
        1
    );
}
