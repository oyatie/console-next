//! BW-19 1, 3, 4 on registration.

use console_hr_adapter_postgres::directory::create_duplicates::DuplicateOverride;
use sqlx::PgPool;

use crate::fixture::fixture;
use crate::{kst_day, register};

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn same_name_and_phone_is_refused_until_the_override_names_the_holder(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let (first, _) = register(&f, f.body("dup-1", "REGULAR")).await.unwrap();

    let refused = register(&f, f.body("dup-2", "REGULAR")).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "duplicate_candidate")
    );
    let listed = refused.refusals.unwrap();
    assert_eq!(listed[0]["employee_id"], first.employee.id.to_string());
    assert_eq!(listed[0]["basis"], "name_phone");
    assert_eq!(listed[0]["status"], "ACTIVE");

    // OTHER needs a note (BW-07 catalog), so a bare override is refused.
    let mut bare = f.body("dup-3", "REGULAR");
    bare.duplicate_override = Some(DuplicateOverride {
        candidate_ids: vec![first.employee.id],
        reason_code: "OTHER".into(),
        note: None,
    });
    assert_eq!(
        register(&f, bare).await.unwrap_err().code,
        "reason_note_required"
    );

    let mut confirmed = f.body("dup-4", "REGULAR");
    confirmed.duplicate_override = Some(DuplicateOverride {
        candidate_ids: vec![first.employee.id],
        reason_code: "OTHER".into(),
        note: Some("동명이인, 다른 사람".into()),
    });
    let (second, _) = register(&f, confirmed).await.unwrap();
    assert_ne!(second.employee.id, first.employee.id);
    let (rule, status, consumed): (String, String, bool) = sqlx::query_as(
        "SELECT rule_code, status, consumed_at IS NOT NULL FROM governed_exceptions \
         WHERE subject_type = 'EMPLOYEE' AND subject_id = $1",
    )
    .bind(second.employee.id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (rule.as_str(), status.as_str(), consumed),
        ("DUPLICATE_NAME_CONFIRMED", "RECORDED", true)
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn same_name_and_birth_date_is_a_candidate_and_an_exited_one_offers_rehire(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let mut body = f.body("bd-1", "REGULAR");
    body.birth_date = Some("1990-05-05".into());
    let (first, _) = register(&f, body).await.unwrap();
    sqlx::query(
        "UPDATE employees SET employment_status = 'EXITED', exit_date = '2026-01-31' WHERE id = $1",
    )
    .bind(first.employee.id)
    .execute(&pool)
    .await
    .unwrap();

    let mut again = f.body("bd-2", "REGULAR");
    again.name = "김 등록".into();
    again.phone = "010-9999-0000".into();
    again.birth_date = Some("1990-05-05".into());
    let refused = register(&f, again).await.unwrap_err();
    let listed = refused.refusals.unwrap();
    assert_eq!(listed[0]["basis"], "name_birth_date");
    assert_eq!(listed[0]["status"], "EXITED");
    assert_eq!(listed[0]["remedy"], "rehire");
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn conflicts_carry_distinct_codes_and_same_day_namesakes_only_warn(pool: PgPool) {
    let f = fixture(pool).await;
    let (first, _) = register(&f, f.body("num-1", "REGULAR")).await.unwrap();
    let number = first.employee.employee_number.clone().unwrap();

    let mut taken = f.body("num-2", "REGULAR");
    taken.name = "박다른".into();
    taken.employee_number = number;
    let refused = register(&f, taken).await.unwrap_err();
    assert_eq!(
        (refused.status.as_u16(), refused.code),
        (409, "employee_number_taken")
    );
    assert_eq!(
        refused.refusals.unwrap()[0]["holder"]["id"],
        first.employee.id.to_string()
    );

    let mut reused = f.body("num-1", "REGULAR");
    reused.name = "이다른".into();
    reused.phone = "010-5555-0000".into();
    assert_eq!(
        register(&f, reused).await.unwrap_err().code,
        "idempotency_key_reused"
    );

    let mut namesake = f.body("num-3", "REGULAR");
    namesake.phone = "010-7777-0000".into();
    let (created, warning) = register(&f, namesake).await.unwrap();
    let warning = warning.unwrap();
    assert_eq!(warning.code, "same_name_same_hire_date");
    assert_eq!(warning.employee_ids, vec![first.employee.id]);
    let reread =
        f.hr.employee_detail(f.principal.clone(), created.employee.id)
            .await
            .unwrap();
    for code in ["same_name_in_unit", "same_name_same_hire_date"] {
        let warning = reread.warnings.iter().find(|w| w.code == code).unwrap();
        assert_eq!(warning.employee_ids, vec![first.employee.id]);
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_future_hire_date_is_pre_hire_until_the_runner_onboards_on_the_day(pool: PgPool) {
    let f = fixture(pool.clone()).await;
    let start = kst_day(30);
    let mut body = f.body("pre-1", "REGULAR");
    body.hire_date = Some(start.clone());
    let (created, _) = register(&f, body).await.unwrap();
    let id = created.employee.id;
    assert_eq!(created.employee.status.as_deref(), Some("PRE_HIRE"));
    let state: (String, String, Option<String>) = sqlx::query_as(
        "SELECT state, effective_date, from_status FROM employee_lifecycle_events \
         WHERE employee_id = $1 AND event_type = 'ONBOARD'",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        state,
        ("SCHEDULED".into(), start.clone(), Some("PRE_HIRE".into()))
    );
    let bound = |pool: PgPool| async move {
        sqlx::query_scalar::<_, i64>(
            "SELECT count(*) FROM employment_source_bindings WHERE employee_id = $1",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap()
    };
    assert_eq!(
        bound(pool.clone()).await,
        0,
        "not employed before the first day"
    );

    // The day before: nothing applies.
    f.hr.apply_due(
        time::Date::parse(
            &kst_day(29),
            &time::format_description::well_known::Iso8601::DATE,
        )
        .unwrap(),
    )
    .await
    .unwrap();
    let status: String =
        sqlx::query_scalar("SELECT employment_status FROM employees WHERE id = $1")
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(status, "PRE_HIRE");

    f.hr.apply_due(
        time::Date::parse(&start, &time::format_description::well_known::Iso8601::DATE).unwrap(),
    )
    .await
    .unwrap();
    let (status, state): (String, String) = sqlx::query_as(
        "SELECT e.employment_status, l.state FROM employees e \
         JOIN employee_lifecycle_events l ON l.employee_id = e.id AND l.event_type = 'ONBOARD' \
         WHERE e.id = $1",
    )
    .bind(id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((status.as_str(), state.as_str()), ("ACTIVE", "APPLIED"));
    assert_eq!(
        bound(pool).await,
        1,
        "the canonical employment opens on the day"
    );
}
