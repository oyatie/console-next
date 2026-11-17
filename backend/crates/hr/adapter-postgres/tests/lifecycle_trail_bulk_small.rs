// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used)]
#[allow(dead_code)]
#[path = "emp_create/fixture.rs"]
mod fixture;
#[path = "support/lifecycle_grant.rs"]
mod lifecycle_grant;
#[allow(dead_code)]
#[path = "support/trail_queries.rs"]
mod trail_queries;

use console_hr_adapter_postgres::clock::today_kst;
use serde_json::json;
use sqlx::PgPool;
use time::Duration;
use tracing::instrument::WithSubscriber;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_appointments_keep_employee_pairs_and_refuse_a_frozen_date_before_writing(
    pool: PgPool,
) {
    let f = fixture::fixture(pool.clone()).await;
    lifecycle_grant::grant(
        &pool,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
    )
    .await;
    let today = today_kst();
    let mut employees = Vec::new();
    for n in 0..2 {
        let mut body = f.body(&format!("appointment-{n}"), "REGULAR");
        body.name = format!("Synthetic employee {n}");
        body.company = format!("Synthetic company {n}");
        body.position = format!("Synthetic position {n}");
        body.hire_date = Some((today - Duration::days(1)).to_string());
        employees.push(f.create(body).await.unwrap().employee_id());
    }
    // Reverse the input so positional pairing cannot depend on the employee lock order.
    employees.reverse();
    let before: Vec<(Uuid, String, Option<String>, i32)> = sqlx::query_as(
        "SELECT id,company,position,head_version FROM employees WHERE id=ANY($1) ORDER BY id",
    )
    .bind(&employees)
    .fetch_all(&pool)
    .await
    .unwrap();
    let lock: Uuid = sqlx::query_scalar(
        "INSERT INTO period_locks (org_id,domain,period_start,period_end,reason) \
         VALUES ($1,'payroll',$2,$2,'Synthetic closed period') RETURNING id",
    )
    .bind(f.principal.org_id.as_uuid())
    .bind(today)
    .fetch_one(&pool)
    .await
    .unwrap();
    let body = json!({"event_type":"APPOINT","to_job":"Synthetic duties","effective_date":today.to_string(),
        "comment":"Synthetic appointment","employee_ids":employees});
    let key = Uuid::new_v4().to_string();
    let error =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            key.clone(),
            serde_json::from_value(body.clone()).unwrap(),
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "period_locked");
    let after: Vec<(Uuid, String, Option<String>, i32)> = sqlx::query_as(
        "SELECT id,company,position,head_version FROM employees WHERE id=ANY($1) ORDER BY id",
    )
    .bind(&employees)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(before, after);
    let events: i64 = sqlx::query_scalar("SELECT count(*) FROM employee_lifecycle_events WHERE employee_id=ANY($1) AND event_type='APPOINT'")
        .bind(&employees).fetch_one(&pool).await.unwrap();
    assert_eq!(events, 0);
    sqlx::query(
        "UPDATE period_locks SET unlocked_at=now(),unlock_reason='Synthetic reopen' WHERE id=$1",
    )
    .bind(lock)
    .execute(&pool)
    .await
    .unwrap();
    let queries = trail_queries::Queries::default();
    let result =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            key.clone(),
            serde_json::from_value(body.clone()).unwrap(),
        )
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    let replay =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            key,
            serde_json::from_value(body).unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(result, replay);
    assert_eq!(
        queries
            .statements()
            .iter()
            .filter(|sql| sql.contains("UPDATE employees"))
            .count(),
        1
    );
    for (id, company, position, version) in before {
        let head: (String, Option<String>, i32, Option<String>) =
            sqlx::query_as("SELECT company,position,head_version,job FROM employees WHERE id=$1")
                .bind(id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(
            head,
            (
                company,
                position,
                version + 1,
                Some("Synthetic duties".to_owned())
            )
        );
        let event = result["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["employee_id"] == json!(id))
            .unwrap();
        let observed: String = sqlx::query_scalar(
            "SELECT i.observed_ref->>'id' FROM lifecycle_cases c \
            JOIN lifecycle_case_items i ON i.org_id=c.org_id AND i.case_id=c.id \
            WHERE c.employee_id=$1 AND c.kind='APPOINT' AND i.item_key='R1'",
        )
        .bind(id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(observed, event["id"].as_str().unwrap());
    }
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn bulk_cases_roll_back_with_the_event_and_scheduled_replay_keeps_one_pending_case(
    pool: PgPool,
) {
    let f = fixture::fixture(pool.clone()).await;
    lifecycle_grant::grant(
        &pool,
        *f.principal.org_id.as_uuid(),
        *f.principal.user_id.as_uuid(),
    )
    .await;
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
    let queries = trail_queries::Queries::default();
    let first =
        f.hr.bulk_lifecycle_events(
            f.principal.clone(),
            key.clone(),
            serde_json::from_value(request.clone()).unwrap(),
        )
        .with_subscriber(queries.clone())
        .await
        .unwrap();
    let statements = queries.statements();
    assert_eq!(
        statements
            .iter()
            .filter(|sql| sql.contains("INSERT INTO audit_events"))
            .count(),
        1,
        "the real bulk command writes its audits in one insert"
    );
    for query in ["FOR UPDATE OF e", "AS exit_owned"] {
        assert_eq!(
            statements.iter().filter(|sql| sql.contains(query)).count(),
            1,
            "prepare the whole selection with one read: {query}"
        );
    }
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
