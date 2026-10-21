//! MR-7: an import creates the profile and the 법인 · 사업장 assignment of
//! the people it inserts (미배치 allowed), and every change it makes to a
//! person on file is a correction-ledger row naming the run. A replayed apply
//! writes nothing twice.

use console_hr_domain::import::plan::Decisions;
use sqlx::PgPool;
use uuid::Uuid;

use crate::import_fixture::{importer, line};

/// `(사번, 법인, 사업장, cause, 고용형태)`.
type Person = (
    String,
    Option<Uuid>,
    Option<Uuid>,
    Option<String>,
    Option<String>,
);
/// `(field, old, new, reason, run)`.
type LedgerRow = (
    String,
    Option<serde_json::Value>,
    serde_json::Value,
    String,
    Option<Uuid>,
);

/// Everyone, by 사번.
async fn people(pool: &PgPool) -> Vec<Person> {
    sqlx::query_as(
        "SELECT e.employee_number, a.legal_entity_id, a.workplace_id, a.cause, p.employment_type \
         FROM employees e \
         LEFT JOIN employment_assignments a ON a.employee_id = e.id AND a.superseded_at IS NULL \
         LEFT JOIN employee_employment_profiles p ON p.employee_id = e.id \
         ORDER BY e.employee_number",
    )
    .fetch_all(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn new_people_get_their_profile_and_placement_and_the_rest_stay_unplaced(pool: PgPool) {
    let im = importer(pool.clone()).await;
    let (entity, hq) = (im.entity, im.workplace);
    let mut by_unit = line("E-1", "김일");
    by_unit.kind = Some("REGULAR");
    let mut unknown = line("E-2", "이이");
    unknown.unit = Some("없는팀");
    unknown.kind = Some("촉탁");
    let mut by_site = line("E-3", "박삼");
    by_site.unit = None;
    by_site.site = Some("본사");
    let run = im.preview("명부.xlsx", &[by_unit, unknown, by_site]).await;
    // W02: a label nobody mapped keeps apply closed; `null` leaves it empty.
    let answer = Decisions {
        employment_type_map: [("촉탁".to_owned(), None)].into_iter().collect(),
        ..Decisions::default()
    };
    let plan = im.dry_run(run, answer).await;
    assert_eq!(plan.unsettled_rows, 0);
    im.apply(run, &plan.dry_run_digest).await.unwrap();
    let setup = Some("SETUP_BIND".to_owned());
    let expected = vec![
        (
            "E-1".to_owned(),
            Some(entity),
            Some(hq),
            setup.clone(),
            Some("REGULAR".to_owned()),
        ),
        ("E-2".to_owned(), None, None, None, None),
        ("E-3".to_owned(), Some(entity), Some(hq), setup, None),
    ];
    assert_eq!(people(&pool).await, expected);

    // A second apply of the same dry run replays: nothing is written twice.
    im.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!(people(&pool).await, expected);
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_second_file_updates_through_the_correction_ledger(pool: PgPool) {
    let im = importer(pool.clone()).await;
    im.load("명부.xlsx", &[line("E-1", "김일"), line("E-2", "이이")])
        .await;

    let mut again = line("E-1", "김일");
    again.job = Some("총무");
    again.kind = Some("PART_TIME");
    // Only a 고용형태: the batch changes no column, the settle the profile.
    let mut only_kind = line("E-2", "이이");
    only_kind.kind = Some("REGULAR");
    let run = im.preview("명부2.xlsx", &[again, only_kind]).await;
    let plan = im.dry_run(run, Decisions::default()).await;
    assert_eq!(plan.update_candidates, 2);
    im.apply(run, &plan.dry_run_digest).await.unwrap();
    im.apply(run, &plan.dry_run_digest).await.unwrap();

    let job: Option<String> =
        sqlx::query_scalar("SELECT job FROM employees WHERE employee_number = 'E-1'")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(job.as_deref(), Some("총무"));
    let kinds: Vec<Option<String>> = people(&pool).await.into_iter().map(|p| p.4).collect();
    assert_eq!(
        kinds,
        vec![Some("PART_TIME".into()), Some("REGULAR".into())]
    );
    let ledger: Vec<LedgerRow> = sqlx::query_as(
        "SELECT c.field, c.old_value, c.new_value, c.reason_code, c.import_run_id \
         FROM employee_corrections c JOIN employees e ON e.id = c.employee_id \
         ORDER BY e.employee_number, c.field",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        ledger,
        vec![
            (
                "employment_type".into(),
                None,
                serde_json::json!("PART_TIME"),
                "IMPORT_APPLY".into(),
                Some(run)
            ),
            (
                "job".into(),
                None,
                serde_json::json!("총무"),
                "IMPORT_APPLY".into(),
                Some(run)
            ),
            (
                "employment_type".into(),
                None,
                serde_json::json!("REGULAR"),
                "IMPORT_APPLY".into(),
                Some(run)
            ),
        ]
    );
}
