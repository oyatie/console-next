//! UX-R3 IMPORT r3:hire-16 / records-02: the 근로자 명부 (근기법 시행령 §20)
//! facts an import carries — 성별 (its column, else the 주민등록번호's 7th
//! digit; #25: the number is never stored), 종사 업무, 계약종료일, 수습종료일
//! — as dated first records; 직급 stays apart from 직위; the report says what
//! the 명부 still lacks.

use console_hr_domain::import::detect::WorkbookMappingRequest;
use sqlx::PgPool;

use crate::harness::{decisions, importer, map, table};

/// (성명, 성별, 직위, 직무) as stored.
type Facts = (String, Option<String>, Option<String>, Option<String>);

/// regression (r3:hire-16, records-02): 성별 and the contract and probation
/// ends were 「가져오지 않음」 and every imported person's 명부 read 성별 빠짐,
/// although the sealed 주민등록번호 states it; 직급 overwrote 직위.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_register_facts_come_in_as_first_records(pool: PgPool) {
    let i = importer(pool).await;
    let rows: &[&[&str]] = &[
        &[
            "사번",
            "성명",
            "입사일",
            "고용형태",
            "성별",
            "주민등록번호",
            "직위",
            "직급",
            "종사 업무",
            "계약종료일",
            "수습종료일",
        ],
        &[
            "R-1",
            "김여름",
            "2024-03-04",
            "계약직",
            "여",
            "",
            "대리",
            "G3",
            "생산 관리",
            "2026-12-31",
            "2024-06-03",
        ],
        &[
            "R-2",
            "박가을",
            "2024-03-04",
            "정규직",
            "",
            "900101-1234567",
            "과장",
            "G4",
            "품질",
            "",
            "",
        ],
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
    let mut answers = decisions();
    answers.employment_type_map = map(&[
        ("계약직", Some("CONTRACT".to_owned())),
        ("정규직", Some("REGULAR".to_owned())),
    ]);
    let plan = i.dry_run(run, answers).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    let report = i.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!(report.inserted, 2);

    let facts: Vec<Facts> = sqlx::query_as(
        "SELECT e.name, f.sex, e.position, e.job FROM employees e \
         LEFT JOIN employee_register_facts f ON f.org_id = e.org_id AND f.employee_id = e.id \
         WHERE e.org_id = $1 ORDER BY e.name",
    )
    .bind(i.org())
    .fetch_all(&i.owner)
    .await
    .unwrap();
    assert_eq!(
        facts,
        vec![
            (
                "김여름".into(),
                Some("FEMALE".into()),
                Some("대리".into()),
                Some("생산 관리".into())
            ),
            (
                "박가을".into(),
                Some("MALE".into()),
                Some("과장".into()),
                Some("품질".into())
            ),
        ],
        "성별 from the column, else the 주민등록번호; 직위 never the 직급"
    );
    let ends: (Option<String>, Option<String>) = sqlx::query_as(
        "SELECT p.contract_end_date::TEXT, p.probation_end_date::TEXT \
         FROM employee_employment_profiles p JOIN employees e ON e.id = p.employee_id \
         WHERE e.org_id = $1 AND e.name = '김여름'",
    )
    .bind(i.org())
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(ends, (Some("2026-12-31".into()), Some("2024-06-03".into())));
    // Each first record is a ledger row naming the run.
    assert_eq!(
        i.count(
            "SELECT count(*) FROM employee_corrections WHERE org_id = $1 AND field = 'sex' \
             AND import_run_id IS NOT NULL"
        )
        .await,
        2
    );
    let gaps = report
        .register_gaps
        .expect("the report names the 명부 gaps");
    assert_eq!(
        (
            gaps.people,
            gaps.sex,
            gaps.address,
            gaps.careers,
            gaps.exit_reason
        ),
        (2, 0, 2, 2, 0)
    );
}

/// A 계약종료일 before the 입사일 is refused on its cell (never a silent drop).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_contract_end_before_the_hire_date_is_refused_on_its_cell(pool: PgPool) {
    let i = importer(pool).await;
    let rows: &[&[&str]] = &[
        &["사번", "성명", "입사일", "계약종료일"],
        &["R-9", "이봄", "2024-03-04", "2023-12-31"],
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
    let plan = i.dry_run(run, decisions()).await;
    let row = &plan.rows[0];
    assert_eq!(
        (row.outcome, row.refusal_code, row.refusal_field),
        ("refused", Some("invalid_date"), Some("contract_end_date"))
    );
    assert_eq!(
        i.count("SELECT count(*) FROM employees WHERE org_id = $1")
            .await,
        0
    );
}
