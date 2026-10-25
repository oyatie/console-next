// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;

use console_hr_adapter_postgres::clock::today_kst;
use serde_json::json;
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_cases_roll_back_with_the_event_and_scheduled_replay_keeps_one_pending_case(
    pool: PgPool,
) {
    let f = fixture::fixture(pool.clone()).await;
    let mut employees = Vec::new();
    for key in ["batch-trail-one", "batch-trail-two"] {
        let mut body = f.body(key, "REGULAR");
        body.hire_date = Some((today_kst() - Duration::days(1)).to_string());
        employees.push(f.create(body).await.unwrap().employee_id());
    }
    let digest = "SELECT md5(string_agg(to_jsonb(e)::text, ',' ORDER BY e.id)) FROM employees e WHERE e.id=ANY($1)";
    let before: String = sqlx::query_scalar(digest)
        .bind(&employees)
        .fetch_one(&pool)
        .await
        .unwrap();
    sqlx::raw_sql(sqlx::AssertSqlSafe("CREATE FUNCTION synthetic_case_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.kind='APPOINT' THEN RAISE EXCEPTION 'synthetic case write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_case_failure BEFORE INSERT ON lifecycle_cases FOR EACH ROW EXECUTE FUNCTION synthetic_case_failure();".to_owned()))
        .execute(&pool).await.unwrap();
    let body = |on| json!({"event_type":"APPOINT","to_job":"개발","effective_date":on,"comment":"합성 일괄 발령","employee_ids":employees});
    f.hr.bulk_lifecycle_events(
        f.principal.clone(),
        Uuid::new_v4().to_string(),
        serde_json::from_value(body(today_kst().to_string())).unwrap(),
    )
    .await
    .unwrap_err();
    let counts: (i64,i64) = sqlx::query_as("SELECT (SELECT count(*) FROM employee_lifecycle_events WHERE employee_id=ANY($1) AND event_type='APPOINT'),(SELECT count(*) FROM lifecycle_cases WHERE employee_id=ANY($1) AND kind='APPOINT')")
        .bind(&employees).fetch_one(&pool).await.unwrap();
    assert_eq!(counts, (0, 0));
    let after: String = sqlx::query_scalar(digest)
        .bind(&employees)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        before, after,
        "case failure also rolls back the employee heads"
    );
    sqlx::raw_sql(sqlx::AssertSqlSafe("DROP TRIGGER synthetic_case_failure ON lifecycle_cases; DROP FUNCTION synthetic_case_failure();".to_owned())).execute(&pool).await.unwrap();
    let request = body((today_kst() + Duration::days(1)).to_string());
    let key = Uuid::new_v4().to_string();
    let first =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            key.clone(),
            serde_json::from_value(request.clone()).unwrap(),
        )
        .await
        .unwrap();
    let replay =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            key,
            serde_json::from_value(request).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first, replay);
    let (cases,pending,items): (i64,i64,i64) = sqlx::query_as("SELECT count(DISTINCT c.id),count(i.id) FILTER (WHERE i.status='PENDING_TRIGGER'),count(i.id) FROM lifecycle_cases c JOIN lifecycle_case_items i ON i.org_id=c.org_id AND i.case_id=c.id WHERE c.employee_id=ANY($1) AND c.kind='APPOINT'")
        .bind(&employees).fetch_one(&pool).await.unwrap();
    assert_eq!(cases, i64::try_from(employees.len()).unwrap());
    assert!(items > 0);
    assert_eq!(pending, items);
}
