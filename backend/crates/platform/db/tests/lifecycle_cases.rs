#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! LC-B3 (migration 0314) invariants, each with its refusal:
//! - an unknown item kind is refused (closed vocabulary);
//! - 「기한 미확인」 never carries a date, and template due rules keep their shape;
//! - nobody completes an item of their own case (DB backstop of the Cedar forbid);
//! - a result is write-once (attestation_immutable), CORRECTION_NEEDED aside;
//! - a case does not close over an open blocking item;
//! - tenant additions are append-only and cannot touch the statutory rows;
//! - the EXIT template ships its design rows and IACI filing, HOLD, [U] rows UNKNOWN;
//! - the exit-case backfill: CANCELLED / PRE_CONSOLE-closed / live, idempotent.

#[path = "lc_fixtures/mod.rs"]
mod lc_fixtures;

use lc_fixtures::{case, live_exit, refused, run};
use sqlx::PgPool;
use uuid::Uuid;

static MIGRATOR: sqlx::migrate::Migrator = sqlx::migrate!("./migrations");

#[sqlx::test(migrator = "MIGRATOR")]
async fn an_unknown_item_kind_and_a_guessed_deadline_are_refused(pool: PgPool) {
    let c = case(&pool, &live_exit(), "REPORTED").await;
    let insert = "INSERT INTO lifecycle_case_items (org_id, case_id, item_key, source, label_ko, kind, venue, mode, \
                  owner_line, due_disposition, status, blocks_close, legal) \
                  VALUES ($1, $2, 'T1', 'AD_HOC', '장비 반납', 'XYZ', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', \
                  'HOLD', 'OPEN', false, false)";
    refused(
        run(&pool, insert, &c, &[]).await,
        "lifecycle_case_items_kind_check",
    );
    // DMg2-style [U] items: an UNKNOWN deadline never gets a date, on insert or later.
    refused(
        run(
            &pool,
            "UPDATE lifecycle_case_items SET due_date = '2026-12-01' \
                    WHERE org_id = $1 AND case_id = $2 AND due_disposition = 'UNKNOWN'",
            &c,
            &[],
        )
        .await,
        "lifecycle_case_items_no_guessed_deadline",
    );
    let unknown: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM lifecycle_case_items WHERE case_id = $1 AND due_disposition = 'UNKNOWN'",
    )
    .bind(c.case)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(unknown >= 1, "X3 is 「기한 미확인」");
    // A template row cannot carry a date where its rule is UNKNOWN.
    let bad_rule = sqlx::query(
        "INSERT INTO case_template_items (template_key, version, item_key, ord, label_ko, kind, venue, mode, \
             owner_line, due_anchor, due_rule_kind, blocks_close, legal, basis_tag) \
         VALUES ('EXIT', 1, 'Z1', 99, 'x', 'DOC', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', 'EXIT_DATE', 'UNKNOWN', \
                 true, false, 'U')",
    )
    .execute(&pool)
    .await
    .unwrap_err();
    assert!(
        bad_rule
            .to_string()
            .contains("case_template_items_due_shape"),
        "{bad_rule}"
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn nobody_completes_an_item_of_their_own_case(pool: PgPool) {
    let c = case(&pool, &live_exit(), "REPORTED").await;
    let complete = "UPDATE lifecycle_case_items SET status = 'DONE_OBSERVED', done_at = now(), done_by = $3, \
                    observed_ref = '{\"table\": \"x\"}' WHERE org_id = $1 AND case_id = $2 AND item_key = 'X2'";
    refused(
        run(&pool, complete, &c, &[c.subject_user]).await,
        "self_completion",
    );
    assert_eq!(run(&pool, complete, &c, &[c.hr]).await, Ok(1));
    // The account <-> person link is what makes it their own case.
    let linked: Option<Uuid> = sqlx::query_scalar("SELECT employee_id FROM users WHERE id = $1")
        .bind(c.subject_user)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(linked, Some(c.employee));
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn a_result_is_write_once_and_a_case_does_not_close_over_open_items(pool: PgPool) {
    let c = case(&pool, &live_exit(), "REPORTED").await;
    refused(
        run(&pool, "UPDATE lifecycle_cases SET state = 'CLOSED', closed_at = now(), close_basis = 'ALL_TERMINAL' \
                         WHERE org_id = $1 AND id = $2", &c, &[]).await,
        "case_has_open_items",
    );
    let done = "UPDATE lifecycle_case_items SET status = 'DONE_OBSERVED', done_at = now(), \
                observed_ref = '{\"table\": \"employee_lifecycle_events\"}' \
                WHERE org_id = $1 AND case_id = $2 AND item_key = 'X2'";
    assert_eq!(run(&pool, done, &c, &[]).await, Ok(1));
    refused(
        run(
            &pool,
            "UPDATE lifecycle_case_items SET observed_ref = '{\"table\": \"other\"}' \
                         WHERE org_id = $1 AND case_id = $2 AND item_key = 'X2'",
            &c,
            &[],
        )
        .await,
        "attestation_immutable",
    );
    refused(
        run(
            &pool,
            "UPDATE lifecycle_case_items SET status = 'OPEN', done_at = NULL, observed_ref = NULL \
                         WHERE org_id = $1 AND case_id = $2 AND item_key = 'X2'",
            &c,
            &[],
        )
        .await,
        "attestation_immutable",
    );
    // The one way on: CORRECTION_NEEDED keeps what was recorded.
    let corrected = "UPDATE lifecycle_case_items SET status = 'CORRECTION_NEEDED', version = version + 1 \
                     WHERE org_id = $1 AND case_id = $2 AND item_key = 'X2'";
    assert_eq!(run(&pool, corrected, &c, &[]).await, Ok(1));
    // A typed status needs what it names: an attestation needs its exception.
    refused(
        run(&pool, "UPDATE lifecycle_case_items SET status = 'DONE_ATTESTED', done_at = now(), done_by = $3 \
                    WHERE org_id = $1 AND case_id = $2 AND item_key = 'X6'", &c, &[c.hr]).await,
        "lifecycle_case_items_status_shape",
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn tenant_additions_are_append_only_and_cannot_touch_statutory_rows(pool: PgPool) {
    let c = case(&pool, &live_exit(), "REPORTED").await;
    let add = |key: &'static str| {
        let pool = pool.clone();
        async move {
            sqlx::query(
                "INSERT INTO tenant_case_template_items (org_id, template_key, item_key, label_ko, kind, venue, mode, \
                     owner_line, blocks_close, effective_from, created_by, reason_code) \
                 VALUES ($1, 'EXIT', $2, '보안서약 해지', 'DOC', 'OUTSIDE', 'ATTESTED', 'hr_basic.edit', false, \
                         current_date, $3, 'TENANT_POLICY')",
            )
            .bind(c.org)
            .bind(key)
            .bind(c.hr)
            .execute(&pool)
            .await
            .map(|r| r.rows_affected())
            .map_err(|e| e.to_string())
        }
    };
    assert_eq!(add("T1").await, Ok(1));
    // A tenant row cannot take a statutory key (no shadowing, no loosening).
    refused(add("X6").await, "item_key_check");
    let close = "UPDATE tenant_case_template_items SET effective_to = current_date + 1 \
                 WHERE org_id = $1 AND $2::uuid IS NOT NULL";
    assert_eq!(run(&pool, close, &c, &[]).await, Ok(1));
    refused(run(&pool, close, &c, &[]).await, "template_item_statutory");
    refused(
        run(
            &pool,
            "DELETE FROM tenant_case_template_items WHERE org_id = $1 AND $2::uuid IS NOT NULL",
            &c,
            &[],
        )
        .await,
        "template_item_statutory",
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn the_exit_template_ships_the_design_rows_on_hold(pool: PgPool) {
    let (rows, base, hold, unknown): (i64, i64, String, Vec<String>) = sqlx::query_as(
        "SELECT count(*), count(*) FILTER (WHERE i.variants IS NULL), min(t.release_disposition), \
                array_agg(i.item_key ORDER BY i.item_key) FILTER (WHERE i.due_rule_kind = 'UNKNOWN') \
         FROM case_template_items i JOIN case_templates t USING (template_key, version) WHERE template_key = 'EXIT'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (rows, base, hold.as_str()),
        (41, 20, "HOLD"),
        "§3.6: 19 base + IACI filing + 17 by reason + GT1-GT4"
    );
    assert_eq!(
        unknown,
        ["DMg2", "TE1", "X3"],
        "[U] rows are 「기한 미확인」"
    );
    let sf_keys: Vec<String> = sqlx::query_scalar(
        "SELECT DISTINCT due_register_code FROM case_template_items WHERE template_key='EXIT' AND due_register_code LIKE 'ins.%' ORDER BY 1",
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        sf_keys,
        [
            "ins.deadline.lose.ei",
            "ins.deadline.lose.iaci",
            "ins.deadline.lose.nhis",
            "ins.deadline.lose.nps"
        ]
    );
}

#[sqlx::test(migrator = "MIGRATOR")]
async fn past_exits_backfill_closed_pre_console_and_cancelled_ones_without_items(pool: PgPool) {
    // An exit long past the soft window: CLOSED, every item NOT_APPLICABLE{PRE_CONSOLE}
    // except a fact the console holds (none here), and nothing overdue.
    let old = case(&pool, "2024-03-31", "HQ_CONFIRMED").await;
    let (state, basis, items, pre, overdue): (String, Option<String>, i64, i64, i64) = sqlx::query_as(
        "SELECT k.state, k.close_basis, count(i.id), count(i.id) FILTER (WHERE i.status_code = 'PRE_CONSOLE'), \
                count(i.id) FILTER (WHERE i.status IN ('OPEN', 'BLOCKED', 'PENDING_TRIGGER')) \
         FROM lifecycle_cases k LEFT JOIN lifecycle_case_items i ON i.case_id = k.id WHERE k.id = $1 GROUP BY 1, 2",
    )
    .bind(old.case)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (state.as_str(), basis.as_deref(), items, pre, overdue),
        ("CLOSED", Some("ALL_TERMINAL"), 26, 26, 0)
    );
    let cancelled = case(&pool, &live_exit(), "CANCELLED").await;
    let (state, items): (String, i64) = sqlx::query_as(
        "SELECT k.state, (SELECT count(*) FROM lifecycle_case_items i WHERE i.case_id = k.id) \
         FROM lifecycle_cases k WHERE k.id = $1",
    )
    .bind(cancelled.case)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!((state.as_str(), items), ("CANCELLED", 0));
    let live = case(&pool, &live_exit(), "REPORTED").await;
    let (state, open, pending): (String, i64, i64) = sqlx::query_as(
        "SELECT k.state, count(*) FILTER (WHERE i.status = 'OPEN'), count(*) FILTER (WHERE i.status = 'PENDING_TRIGGER') \
         FROM lifecycle_cases k JOIN lifecycle_case_items i ON i.case_id = k.id WHERE k.id = $1 GROUP BY 1",
    )
    .bind(live.case)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(
        (state.as_str(), open, pending),
        ("OPEN", 24, 2),
        "X12/X13 wait for a request"
    );
    for c in [&old, &cancelled, &live] {
        let again: i64 = sqlx::query_scalar("SELECT lifecycle_backfill_exit_cases($1)")
            .bind(c.org)
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(again, 0);
    }
}
