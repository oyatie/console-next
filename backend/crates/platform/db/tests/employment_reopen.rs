#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! LC-B1 (migration 0313): a closed employment reopens only under a consumed
//! EXIT_REVERSAL exception of the same tenant; the append-only ledgers admit only
//! an employment_id fill; a backfill finding takes its resolution once; the
//! plan reports what it will not guess, and a rerun writes nothing.

#[path = "lc_fixtures/mod.rs"]
mod lc_fixtures;

use lc_fixtures::{Tenant, exec, head, person, refused, tenant};
use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

async fn exception(pool: &PgPool, t: &Tenant, rule: &str, consumed: bool) -> Uuid {
    sqlx::query_scalar(
        "INSERT INTO governed_exceptions (org_id, rule_code, risk, subject_type, subject_id, reason_code, \
             fingerprint, settings_snapshot, requested_by, status, expires_at, consumed_at) \
         VALUES ($1, $2, 'LOW', 'EMPLOYEE', $1, 'EXIT_RESCINDED', repeat('a', 64), '{}', $3, 'RECORDED', \
                 now() + interval '1 day', CASE WHEN $4 THEN now() END) RETURNING id",
    )
    .bind(t.org)
    .bind(rule)
    .bind(t.user)
    .bind(consumed)
    .fetch_one(pool)
    .await
    .unwrap()
}

async fn reopen(pool: &PgPool, head: Uuid, flag: Option<Uuid>) -> Result<u64, String> {
    let mut tx = pool.begin().await.unwrap();
    if let Some(flag) = flag {
        sqlx::query("SELECT set_config('app.employment_reopen', $1, true)")
            .bind(flag.to_string())
            .execute(&mut *tx)
            .await
            .unwrap();
    }
    let done = sqlx::query(
        "UPDATE employment_heads SET valid_to = NULL, exit_date = NULL, exit_reason_code = NULL WHERE id = $1",
    )
    .bind(head)
    .execute(&mut *tx)
    .await
    .map(|r| r.rows_affected())
    .map_err(|e| e.to_string());
    tx.commit().await.unwrap();
    done
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_closed_employment_reopens_only_under_a_consumed_exit_reversal(pool: PgPool) {
    let (t, stranger) = (tenant(&pool).await, tenant(&pool).await);
    let a = person(&pool, &t, "a").await;
    let closed = head(&pool, &t, a, "2024-01-02", Some("2024-06-30"))
        .await
        .unwrap();
    let refusal = "employment_head_reopen_refused";
    refused(reopen(&pool, closed, None).await, refusal);
    refused(reopen(&pool, closed, Some(Uuid::new_v4())).await, refusal);
    refused(
        reopen(
            &pool,
            closed,
            Some(exception(&pool, &t, "EXIT_REVERSAL", false).await),
        )
        .await,
        refusal,
    );
    refused(
        reopen(
            &pool,
            closed,
            Some(exception(&pool, &t, "EXIT_DATE_BACKDATED", true).await),
        )
        .await,
        refusal,
    );
    refused(
        reopen(
            &pool,
            closed,
            Some(exception(&pool, &stranger, "EXIT_REVERSAL", true).await),
        )
        .await,
        refusal,
    );
    // A partial reopen is a change of the close, not a reopen.
    refused(
        exec(
            &pool,
            "UPDATE employment_heads SET exit_date = NULL WHERE id = $1",
            closed,
        )
        .await,
        "employment_head_immutable",
    );
    let granted = exception(&pool, &t, "EXIT_REVERSAL", true).await;
    assert_eq!(reopen(&pool, closed, Some(granted)).await, Ok(1));
    let open: bool = sqlx::query_scalar(
        "SELECT valid_to IS NULL AND exit_date IS NULL FROM employment_heads WHERE id = $1",
    )
    .bind(closed)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(open);
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn ledgers_admit_only_an_employment_id_fill_and_findings_only_a_resolution(pool: PgPool) {
    let t = tenant(&pool).await;
    let a = person(&pool, &t, "a").await;
    let (first, second) = (
        head(&pool, &t, a, "2024-01-02", Some("2024-06-30"))
            .await
            .unwrap(),
        head(&pool, &t, a, "2024-08-01", None).await.unwrap(),
    );
    let event: Uuid = sqlx::query_scalar(
        "INSERT INTO employee_lifecycle_events (org_id, employee_id, event_type, to_status, effective_date, comment, created_by) \
         VALUES ($1, $2, 'TERMINATE', 'EXITED', '2024-06-30', 'x', $3) RETURNING id",
    )
    .bind(t.org)
    .bind(a)
    .bind(t.user)
    .fetch_one(&pool)
    .await
    .unwrap();
    let set = |employment: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query("UPDATE employee_lifecycle_events SET employment_id = $2 WHERE id = $1")
                .bind(event)
                .bind(employment)
                .execute(&pool)
                .await
                .map_err(|e| e.to_string())
        }
    };
    set(first).await.unwrap();
    let moved = set(second).await.unwrap_err();
    assert!(moved.contains("append-only"), "{moved}");
    refused(
        exec(
            &pool,
            "UPDATE employee_lifecycle_events SET comment = 'y' WHERE id = $1",
            event,
        )
        .await,
        "append-only",
    );

    let finding: Uuid = sqlx::query_scalar(
        "INSERT INTO employment_backfill_findings (org_id, employee_id, kind, fingerprint) \
         VALUES ($1, $2, 'ENTITY_CHANGED_WITHOUT_GROUP_TRANSFER', md5('x')) RETURNING id",
    )
    .bind(t.org)
    .bind(a)
    .fetch_one(&pool)
    .await
    .unwrap();
    refused(
        exec(
            &pool,
            "UPDATE employment_backfill_findings SET kind = 'PERIOD_OVERLAP' WHERE id = $1",
            finding,
        )
        .await,
        "only an open finding",
    );
    refused(
        exec(
            &pool,
            "DELETE FROM employment_backfill_findings WHERE id = $1",
            finding,
        )
        .await,
        "append-only",
    );
    let resolve = "UPDATE employment_backfill_findings SET resolved_at = now(), resolution = 'CONFIRMED', \
                   resolved_by = (SELECT id FROM users WHERE org_id = employment_backfill_findings.org_id LIMIT 1) WHERE id = $1";
    exec(&pool, resolve, finding).await.unwrap();
    refused(exec(&pool, resolve, finding).await, "only an open finding");
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn the_plan_reports_what_it_will_not_guess(pool: PgPool) {
    let t = tenant(&pool).await;
    // EXITED with an exit date but no TERMINATE (an imported 퇴사자): closed from
    // employees.exit_on, and reported; EXITED with no date stays open, reported.
    let dated: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, \
             hire_date, exit_date, employment_status) \
         VALUES ($1, 'A', 'p', 'roster.xlsx', 's', 1, 'p', '2020-05-01', '2022-12-31', 'EXITED') RETURNING id",
    )
    .bind(t.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let undated: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, source_filename, source_sheet, source_row, source_key, \
             hire_date, employment_status) \
         VALUES ($1, 'A', 'q', 'roster.xlsx', 's', 2, 'q', '2021-05-01', 'EXITED') RETURNING id",
    )
    .bind(t.org)
    .fetch_one(&pool)
    .await
    .unwrap();
    let written: i64 = sqlx::query_scalar("SELECT employment_backfill($1)")
        .bind(t.org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(written > 0);
    let kinds: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT employee_id, kind FROM employment_backfill_findings WHERE org_id = $1 \
         AND kind LIKE 'EXITED%' ORDER BY kind",
    )
    .bind(t.org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        kinds,
        [
            (undated, "EXITED_WITHOUT_EXIT_DATE".into()),
            (dated, "EXITED_WITHOUT_TERMINATE".into())
        ]
    );
    let periods: Vec<(Uuid, Option<String>, String)> = sqlx::query_as(
        "SELECT employee_id, exit_date::text, cause FROM employment_heads WHERE org_id = $1 ORDER BY hire_date",
    )
    .bind(t.org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        periods,
        [
            (dated, Some("2022-12-31".into()), "MIGRATION".into()),
            (undated, None, "MIGRATION".into())
        ]
    );
    let again: i64 = sqlx::query_scalar("SELECT employment_backfill($1)")
        .bind(t.org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(again, 0, "a rerun writes nothing");
}
