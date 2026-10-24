//! UX-R3 IMPORT: a person's 법인 is the 법인 of the 사업장 the import places
//! them at (never the sheet's name), a former employee is found at their
//! 근무지's 사업장, the apply job's terminal step reaches the event stream,
//! and the 미배치 queue reads its own facts.

use console_hr_adapter_postgres::import::apply_drive::Started;
use console_hr_adapter_postgres::import::company::ENTITY_UNDECIDED;
use console_hr_adapter_postgres::import::types::EmployeeImportApplyRequest;
use console_hr_adapter_postgres::import::unplaced::UnplacedQuery;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use sqlx::PgPool;
use uuid::Uuid;

use crate::harness::{Importer, decisions, importer, table};

/// A 법인 「한빛」 with one open 사업장 「본사」.
async fn headquarters(i: &Importer) -> Uuid {
    let (o, entity, workplace) = (i.org(), Uuid::new_v4(), Uuid::new_v4());
    let sql = format!(
        "INSERT INTO legal_entities (org_id, id, needs_confirmation, created_change_mode) \
         VALUES ('{o}', '{entity}', true, 'MIGRATION'); \
         INSERT INTO legal_entity_revisions (org_id, legal_entity_id, version, command_id, \
           effective_from, name, display_name, change_mode, reason_code, payload_digest, \
           settings_snapshot) VALUES ('{o}', '{entity}', 1, gen_random_uuid(), '2020-01-01', \
           '주식회사 한빛', '한빛', 'MIGRATION', 'test', sha256('x'::bytea), '{{}}'); \
         INSERT INTO workplaces (org_id, id, legal_entity_id, needs_confirmation, created_change_mode) \
         VALUES ('{o}', '{workplace}', '{entity}', true, 'MIGRATION'); \
         INSERT INTO workplace_revisions (org_id, workplace_id, version, command_id, effective_from, \
           name, status, change_mode, reason_code, payload_digest, settings_snapshot) VALUES ('{o}', \
           '{workplace}', 1, gen_random_uuid(), '2020-01-01', '본사', 'CONTINUING', 'MIGRATION', \
           'TEST', decode(repeat('00', 32), 'hex'), '{{}}')"
    );
    let mut tx = i.owner.begin().await.unwrap();
    sqlx::query("SET LOCAL session_replication_role = replica")
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("SELECT set_config('app.current_org', $1, true)")
        .bind(o.to_string())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe(sql))
        .execute(tx.as_mut())
        .await
        .unwrap();
    tx.commit().await.unwrap();
    workplace
}

async fn staged(i: &Importer, sheet: &str, rows: &[&[&str]]) -> (Uuid, String) {
    let header: &[&str] = &[
        "사번",
        "성명",
        "입사일",
        "고용형태",
        "근무지",
        "퇴사일",
        "직위",
    ];
    let all: Vec<&[&str]> = std::iter::once(header)
        .chain(rows.iter().copied())
        .collect();
    let run = i
        .preview(
            "명부.xlsx",
            &[table(sheet, 0, &all)],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    (run, plan.dry_run_digest)
}

async fn company(i: &Importer, name: &str) -> String {
    sqlx::query_scalar("SELECT company FROM employees WHERE org_id = $1 AND name = $2")
        .bind(i.org())
        .bind(name)
        .fetch_one(&i.owner)
        .await
        .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_an_import_before_workplace_opening_needs_review_and_keeps_the_hire_date(
    pool: PgPool,
) {
    let i = importer(pool).await;
    let workplace = headquarters(&i).await;
    let run = i
        .preview(
            "승계명부.xlsx",
            &[table(
                "명부",
                0,
                &[
                    &["사번", "성명", "입사일", "고용형태", "근무지"],
                    &["EARLY-1", "김승계", "2016-03-02", "정규직", "본사"],
                    &["OPEN-1", "이개설", "2020-01-01", "정규직", "본사"],
                ],
            )],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let mut answers = decisions();
    answers.workplace_map.insert("본사".into(), Some(workplace));
    let plan = i.dry_run(run, answers).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    let opening_items: Vec<_> = plan
        .review
        .items
        .iter()
        .filter(|item| item.reason == "workplace_not_open_on_date")
        .collect();
    assert_eq!(opening_items.len(), 1, "{:?}", plan.review.items);
    let item = opening_items[0];
    assert!(!item.blocking);
    assert_eq!(item.sheet, "명부");
    assert_eq!(item.row, Some(2));
    assert_eq!(item.cell.as_deref(), Some("C2"));
    assert_eq!(item.field, Some("hire_date"));
    assert_eq!(item.value.as_deref(), Some("2020-01-01"));
    assert!(item.resolution.is_none());
    i.apply(run, &plan.dry_run_digest).await.unwrap();
    let placed: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT e.name, e.hire_date, a.valid_from::text FROM employees e \
         JOIN employment_assignments a ON a.org_id=e.org_id AND a.employee_id=e.id \
         WHERE e.org_id=$1 AND a.workplace_id=$2 AND a.superseded_at IS NULL \
         ORDER BY e.employee_number",
    )
    .bind(i.org())
    .bind(workplace)
    .fetch_all(&i.owner)
    .await
    .unwrap();
    assert_eq!(
        placed,
        vec![
            ("김승계".into(), "2016-03-02".into(), "2020-01-01".into()),
            ("이개설".into(), "2020-01-01".into(), "2020-01-01".into()),
        ]
    );
}

/// regression (r3:hire-01, hire-22): every person of a sheet with no 법인
/// column got the sheet's name (「퇴직자 명단」) as their 법인, and a former
/// employee lost their 사업장.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_the_entity_comes_from_the_workplace_never_the_sheet_name(pool: PgPool) {
    let i = importer(pool).await;
    headquarters(&i).await;
    let (run, digest) = staged(
        &i,
        "퇴직자 명단",
        &[
            &["E-1", "김본사", "2024-03-04", "정규직", "본사", "", "과장"],
            &["E-2", "이모름", "2024-03-04", "정규직", "평택공장", "", ""],
            &[
                "E-3",
                "박퇴직",
                "2015-03-02",
                "정규직",
                "본사",
                "2025-01-28",
                "",
            ],
            &[
                "E-4",
                "최퇴직",
                "2015-03-02",
                "정규직",
                "평택공장",
                "2025-01-28",
                "",
            ],
        ],
    )
    .await;
    i.apply(run, &digest).await.unwrap();
    assert_eq!(company(&i, "김본사").await, ENTITY_UNDECIDED);
    assert_eq!(company(&i, "이모름").await, ENTITY_UNDECIDED);
    assert_eq!(
        company(&i, "박퇴직").await,
        ENTITY_UNDECIDED,
        "a migrated label without an independent certificate is not a legal name"
    );
    assert_eq!(company(&i, "최퇴직").await, ENTITY_UNDECIDED);
    let named_after_sheet = i
        .count("SELECT count(*) FROM employees WHERE org_id = $1 AND company = '퇴직자 명단'")
        .await;
    assert_eq!(named_after_sheet, 0);
    // A former employee is never given a live assignment (they left).
    let exited_placed = i
        .count(
            "SELECT count(*) FROM employment_assignments a JOIN employees e ON e.id = a.employee_id \
             WHERE a.org_id = $1 AND e.employment_status = 'EXITED' AND a.superseded_at IS NULL",
        )
        .await;
    assert_eq!(exited_placed, 0);
}

fn body(digest: &str) -> EmployeeImportApplyRequest {
    EmployeeImportApplyRequest {
        dry_run_digest: digest.into(),
    }
}

/// regression (r3:hire-02): the job's `done` was written with an audit no
/// topic maps, so a screen following the run never heard it finish when the
/// settle wrote nothing (here: former employees only).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_a_job_that_settles_nothing_still_reaches_the_stream_when_done(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(
        &i,
        "퇴사자",
        &[&[
            "E-9",
            "정퇴직",
            "2015-03-02",
            "정규직",
            "",
            "2025-01-28",
            "",
        ]],
    )
    .await;
    let Started::Job(_) =
        i.f.hr
            .start_apply(i.f.principal.clone(), run, body(&digest))
            .await
            .unwrap()
    else {
        panic!("a new apply is a job")
    };
    let org = i.f.principal.org_id;
    i.f.hr
        .drive_apply(Some(i.store.clone()), org, run)
        .await
        .unwrap();
    let job = i.f.hr.apply_job(org, run).await.unwrap();
    assert_eq!((job.state.as_str(), job.done, job.total), ("done", 1, 1));
    assert!(job.report.is_some());
    // The done job is stored in a transaction that also writes an event the
    // import_run topic maps (one transaction: one `created_at`).
    let unheard: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM audit_events p WHERE p.org_id = $1 AND p.target_id = $2 \
           AND p.action = 'data_import.apply.progress' AND p.after_snap->>'state' = 'done' \
           AND NOT EXISTS (SELECT 1 FROM audit_events s JOIN realtime_topic_map m \
                ON m.target_type = s.target_type AND m.action = s.action \
               AND m.resource_type = 'import_run' \
              WHERE s.org_id = p.org_id AND s.target_id = p.target_id \
                AND s.created_at = p.created_at)",
    )
    .bind(i.org())
    .bind(run.to_string())
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(unheard, 0, "the done step reached no import_run event");
}

/// regression (r3:hire-21): the queue showed 「— — —」 for people whose 직위,
/// 고용형태 and 입사일 exist (the screen read them from the roster's first
/// 1,000); the queue now carries them.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn regression_the_unplaced_queue_carries_the_placement_facts(pool: PgPool) {
    let i = importer(pool).await;
    let (run, digest) = staged(
        &i,
        "명부",
        &[&[
            "E-1",
            "김일",
            "2009-12-04",
            "정규직",
            "평택공장",
            "",
            "과장",
        ]],
    )
    .await;
    i.apply(run, &digest).await.unwrap();
    let page =
        i.f.hr
            .import_unplaced(
                i.f.principal.clone(),
                UnplacedQuery {
                    run_id: Some(run),
                    after: None,
                    limit: Some(10),
                },
            )
            .await
            .unwrap();
    let kim = &page.items[0];
    assert_eq!(
        (
            kim.position.as_deref(),
            kim.employment_type.as_deref(),
            kim.hire_date.as_deref(),
            kim.worksite_name.as_deref()
        ),
        (
            Some("과장"),
            Some("REGULAR"),
            Some("2009-12-04"),
            Some("평택공장")
        )
    );
}
