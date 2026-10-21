// SPDX-License-Identifier: LicenseRef-Proprietary
//! Capacity proof for one atomic mixed employee-import reversal.

use std::time::{Duration, Instant};

use console_hr_adapter_postgres::corrections::SecondPersonContext;
use console_hr_adapter_postgres::import::rollback::RollbackRequest;
use console_hr_domain::import::detect::WorkbookMappingRequest;
use console_hr_domain::import::grid::GridSheet;
use sqlx::PgPool;

use crate::harness::{Importer, decisions, importer, table};

fn roster(people: usize, position: &str) -> GridSheet {
    let mut rows = vec![vec![
        "사번".to_owned(),
        "성명".to_owned(),
        "입사일".to_owned(),
        "고용형태".to_owned(),
        "직위".to_owned(),
    ]];
    rows.extend((0..people).map(|n| {
        vec![
            format!("BURST-{n:04}"),
            format!("가상직원{n:04}"),
            "2024-03-04".to_owned(),
            "정규직".to_owned(),
            position.to_owned(),
        ]
    }));
    let borrowed: Vec<Vec<&str>> = rows
        .iter()
        .map(|row| row.iter().map(String::as_str).collect())
        .collect();
    let borrowed: Vec<&[&str]> = borrowed.iter().map(Vec::as_slice).collect();
    table("명부", 0, &borrowed)
}

async fn dependency_calls(i: &Importer) -> Option<(i64, i64)> {
    let installed: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements')",
    )
    .fetch_one(&i.owner)
    .await
    .unwrap();
    if !installed {
        return None;
    }
    Some(
        sqlx::query_as(
            "SELECT \
             COALESCE(sum(calls) FILTER (WHERE query LIKE '%import_rollback:heads%'), 0)::bigint, \
             COALESCE(sum(calls) FILTER (WHERE query LIKE '%import_rollback:blockers%'), 0)::bigint \
             FROM pg_stat_statements \
             WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) \
               AND query NOT LIKE '%pg_stat_statements%'",
        )
        .fetch_one(&i.owner)
        .await
        .unwrap(),
    )
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn two_thousand_people_rollback_atomically_with_bounded_dependency_reads(pool: PgPool) {
    let i = importer(pool).await;
    sqlx::query(
        "INSERT INTO tenant_setting_overrides (org_id, key, value, set_by, reason_code) \
         VALUES ($1, 'import.apply.max_rows', '2000'::jsonb, $2, 'TEST')",
    )
    .bind(i.org())
    .bind(i.f.principal.user_id.as_uuid())
    .execute(&i.owner)
    .await
    .unwrap();
    let seed = i
        .load("seed.xlsx", &[roster(1_000, "사원")], decisions())
        .await;
    assert_eq!(seed.inserted, 1_000);
    let run = i
        .preview(
            "mixed-2000.xlsx",
            &[roster(2_000, "대리")],
            &WorkbookMappingRequest::default(),
        )
        .await
        .unwrap()
        .run_id;
    let plan = i.dry_run(run, decisions()).await;
    assert_eq!(plan.review.blocking, 0, "{:?}", plan.review.items);
    let applied = i.apply(run, &plan.dry_run_digest).await.unwrap();
    assert_eq!((applied.inserted, applied.updated), (1_000, 1_000));
    let preview =
        i.f.hr
            .preview_import_rollback(i.f.principal.clone(), run)
            .await
            .unwrap();
    assert!(preview.blockers.is_empty(), "{:?}", preview.blockers);
    assert_eq!(preview.rows.len(), 2_000);
    assert_eq!(
        preview.rows.iter().filter(|row| row.inserted).count(),
        1_000
    );
    let calls_before = dependency_calls(&i).await;
    let started = Instant::now();
    let outcome =
        i.f.hr
            .rollback_import(
                i.f.principal.clone(),
                run,
                RollbackRequest {
                    preview_digest: preview.preview_digest,
                    acknowledged: true,
                    reason_code: None,
                    note: None,
                    step_up: None,
                },
                None,
                SecondPersonContext {
                    other_eligible_holders: 0,
                    sole_holder_refuse: false,
                    routed: false,
                },
            )
            .await
            .unwrap();
    let elapsed = started.elapsed();
    eprintln!(
        "2,000-person inline rollback: {:.3}s",
        elapsed.as_secs_f64()
    );
    assert!(elapsed <= Duration::from_secs(10), "{elapsed:?}");
    assert_eq!(outcome.status, "ROLLED_BACK");
    if let Some(before) = calls_before {
        let after = dependency_calls(&i).await.unwrap();
        for calls in [after.0 - before.0, after.1 - before.1] {
            assert!((1..=3).contains(&calls), "dependency query calls: {calls}");
        }
    } else {
        eprintln!("pg_stat_statements absent: dependency query-count proof was not measured");
    }
    let state: (String, i64, i64, i64) = sqlx::query_as(
        "SELECT r.status, \
         (SELECT count(*) FROM employees e WHERE e.org_id = r.org_id AND e.voided_at IS NULL \
            AND e.position = '사원'), \
         (SELECT count(*) FROM employees e WHERE e.org_id = r.org_id AND e.voided_at IS NOT NULL \
            AND e.pii_destroyed_at IS NOT NULL), \
         (SELECT count(*) FROM employee_corrections c WHERE c.org_id = r.org_id \
            AND c.import_run_id = r.id AND c.reason_code = 'IMPORT_ROLLBACK') \
         FROM data_import_runs r WHERE r.org_id = $1 AND r.id = $2",
    )
    .bind(i.org())
    .bind(run)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(state, ("ROLLED_BACK".to_owned(), 1_000, 1_000, 1_000));
    let transactions: i64 = sqlx::query_scalar(
        "SELECT count(DISTINCT writer) FROM ( \
         SELECT e.xmin::text AS writer FROM employees e \
         JOIN import_run_row_snapshots s ON s.org_id = e.org_id AND s.employee_id = e.id \
         WHERE s.org_id = $1 AND s.run_id = $2 \
         UNION ALL SELECT c.xmin::text FROM employee_corrections c \
         WHERE c.org_id = $1 AND c.import_run_id = $2 AND c.reason_code = 'IMPORT_ROLLBACK' \
         UNION ALL SELECT a.xmin::text FROM audit_events a \
         WHERE a.org_id = $1 AND a.target_id = $2::text AND a.action = 'data_import.rollback' \
         ) writes",
    )
    .bind(i.org())
    .bind(run)
    .fetch_one(&i.owner)
    .await
    .unwrap();
    assert_eq!(
        transactions, 1,
        "all reversed heads, ledger rows and audit commit together"
    );
}
