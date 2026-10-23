//! BW-10: unknown units (미배치, MR-7), settling new people, atomic and concurrent applies.

use console_hr_adapter_postgres::directory::read_filters::EmployeeListQuery;
use console_hr_domain::import::plan::Decisions;
use sqlx::PgPool;

use crate::import_fixture::{importer, line};
use crate::kst_day;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_unknown_unit_comes_in_unplaced_and_a_mapped_one_binds(pool: PgPool) {
    let im = importer(pool.clone()).await;
    let mut elsewhere = line("E-5", "최오");
    elsewhere.unit = Some("영업팀");
    let run = im.preview("명부.xlsx", &[elsewhere]).await;
    let plan = im.dry_run(run, Decisions::default()).await;
    // MR-7: 미배치 is never a refusal; the name is listed and kept.
    assert_eq!(
        (plan.unsettled_rows, plan.unresolved_org_units.as_slice()),
        (0, &["영업팀".to_owned()][..])
    );
    let report = im.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!((report.inserted, report.org_units_bound), (1, 0));
    let (unit, kept): (Option<uuid::Uuid>, Option<String>) = sqlx::query_as(
        "SELECT org_unit_id, source_metadata->>'unresolved_org_unit' FROM employees \
         WHERE employee_number = 'E-5'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((unit, kept.as_deref()), (None, Some("영업팀")));

    let mut mapped = line("E-6", "최육");
    mapped.unit = Some("영업팀");
    let run = im.preview("명부2.xlsx", &[mapped]).await;
    let mut decisions = Decisions::default();
    decisions.unit_map.insert("영업팀".into(), Some(im.f.unit));
    let plan = im.dry_run(run, decisions).await;
    assert_eq!(plan.unsettled_rows, 0);
    let report = im.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!((report.inserted, report.org_units_bound), (1, 1));
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn new_people_are_settled_by_what_they_are(pool: PgPool) {
    let im = importer(pool.clone()).await;
    let mut coming = line("E-7", "정칠");
    coming.hire = Some(kst_day(20));
    let mut former = line("E-8", "한팔");
    former.exit = Some("2025-12-31");
    let mut current = line("E-6", "윤육");
    current.leave = Some("15.000000");
    let mut unnumbered = line("E-0", "서무");
    unnumbered.number = None;
    let report = im
        .load("명부.xlsx", &[coming, former, current, unnumbered])
        .await;
    assert_eq!(report.inserted, 4);
    let unbound: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM employees e WHERE e.org_id = $1 AND NOT EXISTS (\
         SELECT 1 FROM employee_person_bindings b WHERE b.org_id = e.org_id AND b.employee_id = e.id)",
    )
    .bind(*im.f.principal.org_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        unbound, 0,
        "every imported employee is bound before apply returns"
    );
    let people: Vec<(uuid::Uuid, uuid::Uuid, String, String)> = sqlx::query_as(
        "SELECT e.id, b.person_id, e.name, r.attributes->>'legal_name' FROM employees e \
         JOIN employee_person_bindings b ON b.org_id = e.org_id AND b.employee_id = e.id \
         JOIN LATERAL (SELECT attributes FROM person_revisions \
             WHERE org_id = b.org_id AND person_id = b.person_id ORDER BY version DESC LIMIT 1) r ON true \
         WHERE e.org_id = $1",
    )
    .bind(*im.f.principal.org_id.as_uuid())
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(people.len(), 4, "every row has canonical person facts");
    let page =
        im.f.hr
            .list_employees(im.f.principal.clone(), EmployeeListQuery::default())
            .await
            .unwrap();
    for (employee, person, imported_name, legal_name) in people {
        assert_eq!(legal_name, imported_name);
        let listed = page.items.iter().find(|row| row.id == employee).unwrap();
        assert_eq!(
            serde_json::to_value(listed).unwrap()["person_id"],
            person.to_string()
        );
        let detail =
            im.f.hr
                .employee_detail(im.f.principal.clone(), employee)
                .await
                .unwrap();
        assert_eq!(
            serde_json::to_value(&detail.employee).unwrap()["person_id"],
            person.to_string()
        );
    }

    let (coming, _, status, ..) = im.person("E-7").await;
    assert_eq!(status, "PRE_HIRE");
    let onboard: String = sqlx::query_scalar(
        "SELECT state FROM employee_lifecycle_events WHERE employee_id = $1 AND event_type = 'ONBOARD'",
    )
    .bind(coming)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(onboard, "SCHEDULED");
    let (former, _, status, _, exit) = im.person("E-8").await;
    assert_eq!(
        (status.as_str(), exit.as_deref()),
        ("EXITED", Some("2025-12-31"))
    );
    let mark: Option<bool> = sqlx::query_scalar(
        "SELECT (source_metadata->>'migrated_former_employee')::BOOLEAN FROM employees WHERE id = $1",
    )
    .bind(former)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(mark, Some(true));
    let (current, ..) = im.person("E-6").await;
    let (bound, leave): (i64, Option<String>) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM employment_source_bindings WHERE employee_id = $1), \
                (SELECT leave_remaining::TEXT FROM employees WHERE id = $1)",
    )
    .bind(current)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((bound, leave.as_deref()), (1, Some("15.000000")));
    let assigned: Option<String> =
        sqlx::query_scalar("SELECT employee_number FROM employees WHERE name = '서무'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert!(
        assigned.unwrap().starts_with("E-"),
        "a row without a 사번 gets the tenant's next"
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_failing_row_rolls_the_whole_apply_back(pool: PgPool) {
    let im = importer(pool.clone()).await;
    let run = im
        .preview("명부.xlsx", &[line("E-1", "김일"), line("E-2", "이이")])
        .await;
    let plan = im.dry_run(run, Decisions::default()).await;
    sqlx::raw_sql(
        "CREATE FUNCTION reject_second() RETURNS TRIGGER LANGUAGE plpgsql AS $$ BEGIN \
           IF NEW.name = '이이' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'second'; END IF; \
           RETURN NEW; END $$; \
         CREATE TRIGGER reject_second BEFORE INSERT ON employees \
           FOR EACH ROW EXECUTE FUNCTION reject_second();",
    )
    .execute(&pool)
    .await
    .unwrap();
    im.apply(run, &plan.dry_run_digest).await.unwrap_err();
    let after: (i64, i64, String) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM employees WHERE org_id = $1), \
                (SELECT count(*) FROM import_run_row_snapshots WHERE run_id = $2), \
                (SELECT status FROM data_import_runs WHERE id = $2)",
    )
    .bind(*im.f.principal.org_id.as_uuid())
    .bind(run)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(after, (0, 0, "DRY_RUN".into()));
    sqlx::raw_sql("DROP TRIGGER reject_second ON employees; DROP FUNCTION reject_second();")
        .execute(&pool)
        .await
        .unwrap();
    let report = im.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!(report.inserted, 2);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_applies_at_once_write_and_settle_once(pool: PgPool) {
    let im = importer(pool.clone()).await;
    let mut coming = line("E-3", "강삼");
    coming.hire = Some(kst_day(9));
    let run = im
        .preview("명부.xlsx", &[line("E-1", "김일"), coming])
        .await;
    let plan = im.dry_run(run, Decisions::default()).await;
    let (a, b) = tokio::join!(
        im.apply(run, &plan.dry_run_digest),
        im.apply(run, &plan.dry_run_digest)
    );
    let mut inserted = [a.unwrap().inserted, b.unwrap().inserted];
    inserted.sort_unstable();
    // The second is the stored report of the first (a replay), whichever won.
    assert_eq!(inserted, [2, 2]);
    let counts: (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM employees WHERE org_id = $1), \
                (SELECT count(*) FROM employee_lifecycle_events \
                  WHERE org_id = $1 AND event_type = 'ONBOARD')",
    )
    .bind(*im.f.principal.org_id.as_uuid())
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        counts,
        (2, 1),
        "one person each, one ONBOARD for the 입사 예정 one"
    );
}
