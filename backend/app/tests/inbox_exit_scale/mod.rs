// SPDX-License-Identifier: LicenseRef-Proprietary
//! Compiled with the source's PostgreSQL tests; no new app test target needed.
use super::*;
use console_hr_adapter_postgres::HrService;
use console_kernel_core::{BranchScope, OrgId};
use console_platform_authz::Role;
use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
use std::collections::BTreeSet;
use tracing::instrument::WithSubscriber;

// Reuse the existing SQL observer without adding tracing to test-support's dependencies.
#[path = "../../../crates/hr/adapter-postgres/tests/support/trail_queries.rs"]
#[allow(dead_code)]
mod trail_queries;

mod bounded;
mod parity;

pub(super) async fn grant_exit(pool: &PgPool, org: OrgId, actor: console_kernel_core::UserId) {
    let role = Uuid::new_v4();
    let maker = console_platform_test_support::seed_active_user(
        pool,
        *org.as_uuid(),
        "MEMBER",
        "grant-maker",
    )
    .await;
    sqlx::query("INSERT INTO access_roles (org_id,id,name_ko,status,version,created_by) VALUES ($1,$2,'퇴직 담당','ACTIVE',1,$3)")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_versions (org_id,role_id,version,name_ko,status,change_mode,created_by) VALUES ($1,$2,1,'퇴직 담당','ACTIVE','SETUP',$3)")
        .bind(org.as_uuid()).bind(role).bind(actor.as_uuid()).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_role_lines (org_id,role_id,version,domain,levels) VALUES ($1,$2,1,'hr_basic',ARRAY['view']),($1,$2,1,'exit',ARRAY['edit','approve'])")
        .bind(org.as_uuid()).bind(role).execute(pool).await.unwrap();
    sqlx::query("INSERT INTO access_grants (org_id,account_id,role_id,scope_kind,valid_from,effective_in_setup,change_mode,reason_code,granted_by) VALUES ($1,$2,$3,'TENANT',now()-interval '1 day',true,'SETUP','TEST',$4)")
        .bind(org.as_uuid()).bind(actor.as_uuid()).bind(role).bind(maker.as_uuid()).execute(pool).await.unwrap();
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn exit_source_statement_count_is_flat_at_two_twenty_and_two_thousand_employees(
    pool: PgPool,
) {
    let runtime = runtime_role_pool(&pool).await;
    // Keep pool connection setup outside the measured product future.
    let leases = futures::future::join_all(
        (0..runtime.options().get_max_connections()).map(|_| runtime.acquire()),
    )
    .await
    .into_iter()
    .collect::<Result<Vec<_>, _>>()
    .unwrap();
    drop(leases);
    // Distinct register windows make earliest-deadline selection observable.
    sqlx::query("UPDATE statutory_rules SET value_num = value_num + 3 WHERE code = 'SEVERANCE_PAY_DUE_DAYS'")
        .execute(&pool).await.unwrap();
    let mut counts = Vec::new();
    for employees in [2_i32, 20, 2_000] {
        let org = OrgId::new();
        let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "exit-scale").await;
        grant_exit(&pool, org, actor).await;
        let principal = Principal::new(
            actor,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        sqlx::query(
            "WITH people AS (INSERT INTO employees \
               (org_id, company, name, source_filename, source_sheet, source_row, source_key) \
               SELECT $1, '회사', '김직원', 'console', 'console', n, n::text \
               FROM generate_series(1, $2::int) n RETURNING id, source_row) \
             INSERT INTO employee_exit_cases \
               (org_id, employee_id, status, effective_exit_date, site_manager_note, reported_by) \
               SELECT $1, id, CASE WHEN source_row % 2 = 0 THEN 'SETTLEMENT_READY' ELSE 'REPORTED' END, \
                 CURRENT_DATE + source_row::int, '업무함 검증', $3 FROM people",
        )
        .bind(org.as_uuid())
        .bind(employees)
        .bind(actor.as_uuid())
        .execute(&pool)
        .await
        .unwrap();
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let queries = trail_queries::Queries::default();
        let actual = async {
            let mut actual = page(
                &runtime,
                &principal,
                ActionInboxSourceQuery {
                    filter: Default::default(),
                    require_exact_total: false,
                    now,
                    as_of: now,
                    after: None,
                    limit: 20,
                },
                &Default::default(),
            )
            .await?;
            super::super::audit_personnel::record(&runtime, &principal, &mut actual).await?;
            Ok::<_, KernelError>(actual)
        }
        .with_subscriber(queries.clone())
        .await
        .unwrap();
        let statements = queries.statements();
        assert!(
            !statements.is_empty(),
            "SQL observer must record the source"
        );
        counts.push(statements.len());
        assert_eq!(
            statements
                .iter()
                .filter(|s| s.contains("INSERT INTO audit_events"))
                .count(),
            1,
            "one batched access insert at {employees} employees: {statements:#?}"
        );
        let access: Vec<serde_json::Value> = sqlx::query_scalar(
            "SELECT after_snap FROM audit_events WHERE org_id = $1 AND action = 'employee_exit_case.list_read'"
        ).bind(org.as_uuid()).fetch_all(&pool).await.unwrap();
        assert_eq!(
            access.len(),
            1,
            "one exit access row at {employees} employees"
        );
        let subjects: BTreeSet<Uuid> =
            serde_json::from_value(access[0]["subject_ids"].clone()).unwrap();
        let shown: BTreeSet<Uuid> = actual
            .items
            .iter()
            .flat_map(|i| &i.links)
            .filter(|l| l.kind == "employee")
            .map(|l| l.id.parse().unwrap())
            .collect();
        assert_eq!(
            subjects, shown,
            "access subjects contain only the source page"
        );
        eprintln!(
            "hr_exit employees={employees} statements={}",
            statements.len()
        );
        assert_eq!(actual.total, (employees as usize).min(21));
        assert_eq!(actual.total_is_exact, employees <= 20);
        assert_eq!(actual.items.len(), (employees as usize).min(20));
        assert_eq!(actual.has_more, employees > 20);
        if employees <= 20 {
            assert!(actual.items.iter().any(|i| i.kind == "hr_exit_confirm"));
            assert!(actual.items.iter().any(|i| i.kind == "hr_exit_settle"));
        }
        let register = console_compliance_adapter_postgres::statutory::load_statutory_register(
            &mut runtime.acquire().await.unwrap(),
        )
        .await
        .unwrap();
        for item in &actual.items {
            let id = item.links[0].id.parse().unwrap();
            let case = HrService::new(runtime.clone())
                .exit_case(principal.clone(), id, &register)
                .await
                .unwrap();
            let expected = if item.kind == "hr_exit_settle" {
                let deadlines: Vec<_> = case
                    .settlement_deadlines
                    .unwrap()
                    .into_iter()
                    .filter_map(|d| d.due_date)
                    .filter_map(|d| console_hr_domain::text::parse_yyyy_mm_dd(&d).ok())
                    .collect();
                assert_ne!(deadlines.iter().min(), deadlines.iter().max());
                deadlines.into_iter().min()
            } else {
                Some(console_hr_domain::text::parse_yyyy_mm_dd(&case.effective_exit_date).unwrap())
            };
            assert_eq!(item.due.map(|d| d.date()), expected);
        }
    }
    assert_eq!(
        counts,
        vec![counts[0]; 3],
        "source SQL counts at 2, 20, 2000 employees"
    );
}
