#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! LC-B1 / LC-B3 migration acceptance (inter-entity-transfer.md §4.3,
//! lifecycle-events.md §5.1): a tenant seeded only through the API — two 법인,
//! a plain hire, an exit and a rehire, a 전적, a live exit and a withdrawn one —
//! is backfilled by the same functions migrations 0313/0314 run, with zero loss:
//! `employees` byte-identical, head counts = 1 + REHIRE + GROUP_TRANSFER, no
//! overlapping periods, every assignment inside one period, the same 재직
//! headcount, 연차 untouched, one case per exit case, and a rerun writes nothing.

#[path = "lifecycle_foundation_migration/seed.rs"]
mod seed;

use console_kernel_core::OrgId;
use seed::{Seeded, day, scalar_i64, today};
use serde_json::Value;
use sqlx::PgPool;
use time::Duration;
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_api_seeded_tenant_backfills_into_periods_and_cases_with_zero_loss(pool: PgPool) {
    let Seeded {
        org,
        entity_a: ea,
        entity_b: eb,
        plain,
        rehired,
        moved,
        exit,
        live,
        withdrawn,
    } = seed::seed(&pool).await;

    // Before: every employees row and every 연차 figure.
    let digest = "SELECT string_agg(e.id::text || md5(to_jsonb(e)::text), ',' ORDER BY e.id) FROM employees e WHERE e.org_id = $1";
    let leave = "SELECT string_agg(e.id::text || ':' || coalesce(e.leave_remaining::text, '-') || ':' \
                 || coalesce((SELECT b.leave_remaining::text FROM employee_leave_balances b WHERE b.org_id = e.org_id \
                 AND b.employee_id = e.id), '-'), ',' ORDER BY e.id) FROM employees e WHERE e.org_id = $1";
    let before: (String, Option<String>) = (
        sqlx::query_scalar(digest)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar(leave)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
    );
    let active_before = scalar_i64(
        &pool,
        "SELECT count(*) FROM employees WHERE org_id = $1 \
        AND employment_status IN ('ACTIVE', 'ON_LEAVE')",
        org,
    )
    .await;

    // The migrations' backfills, now over real data.
    let written: i64 = sqlx::query_scalar("SELECT employment_backfill($1)")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert!(written > 0);
    let cases: i64 = sqlx::query_scalar("SELECT lifecycle_backfill_exit_cases($1)")
        .bind(org)
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(cases, 0, "API writes already opened the exit trails");
    assert!(
        scalar_i64(
            &pool,
            "SELECT count(*) FROM lifecycle_cases WHERE org_id=$1 AND trigger_kind='EXIT_CASE'",
            org
        )
        .await
            > 0
    );

    let findings: Vec<(Uuid, String, Value)> = sqlx::query_as(
        "SELECT employee_id, kind, detail FROM employment_backfill_findings WHERE org_id = $1 ORDER BY 1, 2",
    )
    .bind(org)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        findings,
        [],
        "an API-seeded tenant leaves nothing to confirm"
    );

    // Zero loss.
    let after: (String, Option<String>) = (
        sqlx::query_scalar(digest)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
        sqlx::query_scalar(leave)
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap(),
    );
    assert_eq!(
        before, after,
        "employees rows and 연차 balances are untouched"
    );
    let wrong_counts = scalar_i64(&pool, "SELECT count(*) FROM employees e WHERE e.org_id = $1 AND \
        (SELECT count(*) FROM employment_heads h WHERE h.org_id = e.org_id AND h.employee_id = e.id) <> 1 + \
        (SELECT count(*) FROM employee_lifecycle_events l WHERE l.org_id = e.org_id AND l.employee_id = e.id \
           AND l.state = 'APPLIED' AND l.event_type IN ('REHIRE', 'GROUP_TRANSFER') \
           AND NOT EXISTS (SELECT 1 FROM employee_lifecycle_events v WHERE v.voids_event_id = l.id AND v.state = 'APPLIED'))", org).await;
    assert_eq!(
        wrong_counts, 0,
        "heads = 1 + REHIRE + GROUP_TRANSFER for every person"
    );
    let overlaps = scalar_i64(&pool, "SELECT count(*) FROM employment_heads x JOIN employment_heads y \
        ON y.org_id = x.org_id AND y.employee_id = x.employee_id AND y.id <> x.id \
        WHERE x.org_id = $1 AND daterange(x.hire_date, x.exit_date, '[]') && daterange(y.hire_date, y.exit_date, '[]')", org).await;
    assert_eq!(overlaps, 0);
    let misaligned = scalar_i64(
        &pool,
        "SELECT count(*) FROM employment_heads WHERE org_id = $1 AND exit_date IS NOT NULL \
        AND valid_to <> ((exit_date + 1)::timestamp AT TIME ZONE 'Asia/Seoul')",
        org,
    )
    .await;
    assert_eq!(misaligned, 0, "valid_to = exit_date + 1 day (KST)");
    let homeless = scalar_i64(&pool, "SELECT count(*) FROM employment_assignments a WHERE a.org_id = $1 \
        AND a.superseded_at IS NULL AND a.cause <> 'MIGRATION_UNMAPPED' AND (a.employment_id IS NULL OR NOT EXISTS \
        (SELECT 1 FROM employment_heads h WHERE h.id = a.employment_id AND a.valid_from BETWEEN h.hire_date \
         AND coalesce(h.exit_date, 'infinity'::date)))", org).await;
    assert_eq!(homeless, 0, "every assignment lies inside its employment");
    let active_after = scalar_i64(
        &pool,
        "SELECT count(*) FROM employment_heads WHERE org_id = $1 \
        AND hire_date <= (now() AT TIME ZONE 'Asia/Seoul')::date \
        AND coalesce(exit_date, 'infinity'::date) >= (now() AT TIME ZONE 'Asia/Seoul')::date",
        org,
    )
    .await;
    assert_eq!(
        active_after, active_before,
        "the 재직 headcount on today is unchanged"
    );

    // The periods themselves.
    let periods = |who: Uuid| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>, String, String, Option<String>, bool)>(
                "SELECT hire_date::text, exit_date::text, cause, continuity, legal_entity_id::text, \
                        predecessor_employment_id IS NOT NULL \
                 FROM employment_heads WHERE employee_id = $1 ORDER BY hire_date",
            )
            .bind(who)
            .fetch_all(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(
        periods(plain).await,
        [(
            "2025-03-03".into(),
            None,
            "HIRE".into(),
            "NEW".into(),
            Some(ea.clone()),
            false
        )]
    );
    assert_eq!(
        periods(rehired).await,
        [
            (
                "2025-01-02".into(),
                Some(day(-10)),
                "HIRE".into(),
                "NEW".into(),
                Some(ea.clone()),
                false
            ),
            (
                day(-3),
                None,
                "REHIRE".into(),
                "REHIRE".into(),
                Some(ea.clone()),
                true
            ),
        ]
    );
    assert_eq!(
        periods(moved).await,
        [
            (
                "2024-07-01".into(),
                Some(day(-3)),
                "HIRE".into(),
                "NEW".into(),
                Some(ea.clone()),
                false
            ),
            (
                day(-2),
                None,
                "GROUP_TRANSFER".into(),
                "SETTLED".into(),
                Some(eb.clone()),
                true
            ),
        ]
    );

    // One case per exit case: the confirmed exit is live with its TERMINATE
    // observed, the reported one is live, the withdrawn one is cancelled.
    let case_of = |id: String| {
        let pool = pool.clone();
        async move {
            sqlx::query_as::<_, (String, Option<String>, i64, Option<String>)>(
                "SELECT k.state, k.variant, (SELECT count(*) FROM lifecycle_case_items i WHERE i.case_id = k.id), \
                        (SELECT i.status FROM lifecycle_case_items i WHERE i.case_id = k.id AND i.item_key = 'X1') \
                 FROM lifecycle_cases k WHERE k.id = $1::uuid",
            )
            .bind(id)
            .fetch_one(&pool)
            .await
            .unwrap()
        }
    };
    assert_eq!(
        case_of(exit.clone()).await,
        (
            "OPEN".into(),
            Some("RESIGNATION".into()),
            21,
            Some("DONE_OBSERVED".into())
        )
    );
    assert_eq!(
        case_of(live.clone()).await,
        (
            "OPEN".into(),
            Some("RESIGNATION".into()),
            21,
            Some("OPEN".into())
        )
    );
    assert_eq!(
        case_of(withdrawn).await,
        (
            "CANCELLED".into(),
            Some("RESIGNATION".into()),
            21,
            Some("CANCELLED".into())
        )
    );

    // A rerun writes nothing.
    let again: (i64, i64) =
        sqlx::query_as("SELECT employment_backfill($1), lifecycle_backfill_exit_cases($1)")
            .bind(org)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(again, (0, 0));

    // The worker's tick settles the live case's clocks from the register.
    let register = console_compliance_adapter_postgres::PgComplianceStore::new(pool.clone())
        .statutory_register()
        .await
        .unwrap();
    let on = console_hr_domain::text::parse_yyyy_mm_dd(&day(5)).unwrap();
    let filing = register
        .filing_rule_by_code("ins.deadline.lose.nhis", on)
        .unwrap()
        .unwrap();
    let loss = filing.loss_on(on).unwrap();
    assert_eq!(
        serde_json::to_value(filing.deadline.kind).unwrap(),
        serde_json::json!("DAYS")
    );
    let included =
        serde_json::to_value(filing.deadline.first_day).unwrap() == serde_json::json!("INCLUDED");
    let expected_filing = Some(
        (loss + Duration::days(i64::from(filing.deadline.value.unwrap()) - i64::from(included)))
            .to_string(),
    );
    let payment = register.rule("FINAL_PAY_DUE_DAYS", on).unwrap();
    let expected_payment = (on + Duration::days(payment.whole(payment.unit).unwrap())).to_string();
    let hr = console_hr_adapter_postgres::HrService::new(pool.clone());
    hr.case_clock_tick(OrgId::from_uuid(org), today(), register.clone())
        .await
        .unwrap();
    assert_eq!(
        hr.case_clock_tick(OrgId::from_uuid(org), today(), register)
            .await
            .unwrap(),
        0,
        "once a day"
    );
    let clocks: Vec<(String, Option<String>, String)> = sqlx::query_as(
        "SELECT item_key, due_date::text, due_disposition FROM lifecycle_case_items \
         WHERE case_id = $1::uuid AND item_key IN ('X2', 'X3', 'X6', 'X10', 'X12') ORDER BY item_key",
    )
    .bind(&live)
    .fetch_all(&pool)
    .await
    .unwrap();
    assert_eq!(
        clocks,
        [
            ("X10".into(), expected_filing, "HOLD".into()),
            ("X12".into(), None, "HOLD".into()),
            ("X2".into(), None, "UNKNOWN".into()),
            ("X3".into(), None, "UNKNOWN".into()),
            ("X6".into(), Some(expected_payment), "HOLD".into()),
        ]
    );
}
