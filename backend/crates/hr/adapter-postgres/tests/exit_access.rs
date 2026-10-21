#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! governance-04 / move-03 / people-self-19 (regression): a leaver kept every
//! grant, an active account and a working session after HR confirmed the exit.
//! The HR confirmation now ends the linked account's grants at the instant
//! `exit.access.revoke_mode.voluntary` names (END_OF_EXIT_DATE: KST midnight
//! after the 퇴직일) and, once that has passed, suspends the account and ends
//! its sessions — in the exit's own transaction. Red on 99dafebc.

#[path = "support/go_live.rs"]
mod go_live;

use std::collections::BTreeSet;

use console_hr_adapter_postgres::HrService;
use console_hr_adapter_postgres::exits::types::{
    ConfirmEmployeeExitCaseRequest, ReportEmployeeExitCaseRequest,
};
use console_kernel_core::{BranchScope, OrgId, UserId};
use console_platform_authz::{Principal, Role};
use serde_json::json;
use sqlx::PgPool;
use sqlx::postgres::PgPoolOptions;
use time::{Date, OffsetDateTime, UtcOffset};
use uuid::Uuid;

struct World {
    hr: HrService,
    owner: PgPool,
    ops: Principal,
    org: Uuid,
}

async fn world(pool: PgPool) -> World {
    let (org, user) = (OrgId::new(), UserId::new());
    sqlx::query("INSERT INTO organizations (id, slug, name) VALUES ($1, $2, 'exit access')")
        .bind(*org.as_uuid())
        .bind(format!("exa-{}", &org.as_uuid().simple().to_string()[..12]))
        .execute(&pool)
        .await
        .unwrap();
    go_live::go_live(&pool, *org.as_uuid()).await;
    sqlx::query(
        "INSERT INTO users (id, display_name, roles, org_id, is_tenant_ops) VALUES ($1, '운영', '{}', $2, true)",
    )
    .bind(*user.as_uuid())
    .bind(*org.as_uuid())
    .execute(&pool)
    .await
    .unwrap();
    let options = pool.connect_options().as_ref().clone();
    let rt = PgPoolOptions::new()
        .max_connections(2)
        .after_connect(|conn, _| {
            Box::pin(async move {
                sqlx::query("SET ROLE console_rt")
                    .execute(conn)
                    .await
                    .map(|_| ())
            })
        })
        .connect_with(options)
        .await
        .unwrap();
    // The trunk model of the ops principal (every door, org-wide).
    let ops = Principal::new(
        user,
        org,
        BTreeSet::from([Role::SuperAdmin]),
        BranchScope::All,
    );
    World {
        hr: HrService::new(rt),
        owner: pool,
        ops,
        org: *org.as_uuid(),
    }
}

impl World {
    /// An employee with a linked, active account holding two open grants and
    /// one live session family; returns (employee, account).
    async fn hr_worker(&self) -> (Uuid, Uuid) {
        let employee: Uuid = sqlx::query_scalar(
            "INSERT INTO employees (org_id, company, name, position, job, source_filename, \
             source_sheet, source_row, source_key, hire_date) VALUES ($1, 'Co', '김인사', '사원', \
             '인사', 'console', 'console', 1, $2, '2025-01-02') RETURNING id",
        )
        .bind(self.org)
        .bind(Uuid::new_v4().to_string())
        .fetch_one(&self.owner)
        .await
        .unwrap();
        let account = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO users (id, display_name, roles, org_id, employee_id) VALUES ($1, '김인사', '{}', $2, $3)",
        )
        .bind(account)
        .bind(self.org)
        .bind(employee)
        .execute(&self.owner)
        .await
        .unwrap();
        let ops = *self.ops.user_id.as_uuid();
        for until in ["2027-04-06", "2027-10-06"] {
            let role: Uuid = sqlx::query_scalar(
                "INSERT INTO access_roles (org_id, name_ko, status, version, created_by) \
                 VALUES ($1, $3, 'ACTIVE', 1, $2) RETURNING id",
            )
            .bind(self.org)
            .bind(ops)
            .bind(format!("역할 {until}"))
            .fetch_one(&self.owner)
            .await
            .unwrap();
            sqlx::query(
                "INSERT INTO access_grants (org_id, account_id, role_id, scope_kind, valid_from, \
                 valid_to, change_mode, reason_code, granted_by) \
                 VALUES ($1, $2, $3, 'TENANT', now() - interval '1 day', $4::date, 'OPERATING', 'NEW_HIRE', $5)",
            )
            .bind(self.org)
            .bind(account)
            .bind(role)
            .bind(until)
            .bind(ops)
            .execute(&self.owner)
            .await
            .unwrap();
        }
        sqlx::query(
            "INSERT INTO auth_refresh_token_families (user_id, org_id, created_at) VALUES ($1, $2, now())",
        )
        .bind(account)
        .bind(self.org)
        .execute(&self.owner)
        .await
        .unwrap();
        (employee, account)
    }

    async fn exit(&self, employee: Uuid, date: Date) -> Result<(), String> {
        let body: ReportEmployeeExitCaseRequest = serde_json::from_value(json!({
            "employee_id": employee, "effective_exit_date": date.to_string(),
            "site_manager_note": "본인 사정으로 퇴사",
        }))
        .unwrap();
        let (_, case) = self
            .hr
            .report_exit_case(self.ops.clone(), Uuid::new_v4().to_string(), body)
            .await
            .map_err(|e| format!("{e:?}"))?;
        let id: Uuid = case["id"].as_str().unwrap().parse().unwrap();
        let confirm: ConfirmEmployeeExitCaseRequest = serde_json::from_value(json!({
            "signoffs": { "privacy_notice_ack": true, "korean_labor_law_ack": true,
                          "payroll_cutoff_ack": true, "retirement_settlement_ack": true },
        }))
        .unwrap();
        self.hr
            .confirm_exit_case(self.ops.clone(), None, id, confirm)
            .await
            .map(|_| ())
            .map_err(|e| format!("{e:?}"))
    }

    async fn scalar<T>(&self, sql: &'static str, account: Uuid) -> T
    where
        T: for<'r> sqlx::Decode<'r, sqlx::Postgres> + sqlx::Type<sqlx::Postgres> + Send + Unpin,
    {
        sqlx::query_scalar(sql)
            .bind(account)
            .fetch_one(&self.owner)
            .await
            .unwrap()
    }
}

fn kst_today() -> Date {
    OffsetDateTime::now_utc()
        .to_offset(UtcOffset::from_hms(9, 0, 0).unwrap())
        .date()
}

/// regression: governance-04 — a 퇴직일 that has passed ends everything now.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_past_exit_suspends_the_account_and_ends_grants_and_sessions(pool: PgPool) {
    let w = world(pool).await;
    let (employee, account) = w.hr_worker().await;
    let yesterday = kst_today().previous_day().unwrap();
    w.exit(employee, yesterday).await.unwrap();

    let active: bool = w
        .scalar("SELECT is_active FROM users WHERE id = $1", account)
        .await;
    assert!(!active, "the account is suspended");
    let open: i64 = w
        .scalar(
            "SELECT count(*) FROM access_grants WHERE account_id = $1 AND status = 'ACTIVE' \
             AND (valid_to IS NULL OR valid_to > now())",
            account,
        )
        .await;
    assert_eq!(open, 0, "no grant counts any more");
    let live: i64 = w
        .scalar(
            "SELECT count(*) FROM auth_refresh_token_families WHERE user_id = $1 AND revoked_at IS NULL",
            account,
        )
        .await;
    assert_eq!(live, 0, "every session family is revoked");
    let audited: i64 = w
        .scalar(
            "SELECT count(*) FROM audit_events WHERE action = 'user.access.end_on_exit' \
             AND target_id = $1::text",
            account,
        )
        .await;
    assert_eq!(audited, 1);
}

/// A 퇴직일 still ahead: the grants end at KST midnight after it (never later
/// than they would have), and the account stays usable until then.
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_future_exit_ends_grants_at_the_exit_date_and_keeps_the_account(pool: PgPool) {
    let w = world(pool).await;
    let (employee, account) = w.hr_worker().await;
    let date = kst_today().next_day().unwrap();
    w.exit(employee, date).await.unwrap();

    let active: bool = w
        .scalar("SELECT is_active FROM users WHERE id = $1", account)
        .await;
    assert!(active, "not yet: the 퇴직일 is ahead");
    let ends: Vec<OffsetDateTime> = sqlx::query_scalar(
        "SELECT valid_to FROM access_grants WHERE account_id = $1 AND status = 'ACTIVE'",
    )
    .bind(account)
    .fetch_all(&w.owner)
    .await
    .unwrap();
    let expected = date
        .next_day()
        .unwrap()
        .midnight()
        .assume_offset(UtcOffset::from_hms(9, 0, 0).unwrap());
    assert_eq!(ends.len(), 2);
    assert!(
        ends.iter().all(|e| *e == expected),
        "{ends:?} != {expected}"
    );
}

/// Negative: an exit never extends a grant that already ends earlier, and an
/// employee with no account confirms as before (nothing written for access).
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn an_exit_never_extends_a_grant_and_needs_no_account(pool: PgPool) {
    let w = world(pool).await;
    let (employee, account) = w.hr_worker().await;
    sqlx::query(
        "UPDATE access_grants SET valid_to = now() + interval '1 hour' WHERE account_id = $1",
    )
    .bind(account)
    .execute(&w.owner)
    .await
    .unwrap();
    let before: Vec<OffsetDateTime> =
        sqlx::query_scalar("SELECT valid_to FROM access_grants WHERE account_id = $1 ORDER BY id")
            .bind(account)
            .fetch_all(&w.owner)
            .await
            .unwrap();
    w.exit(employee, kst_today().next_day().unwrap())
        .await
        .unwrap();
    let after: Vec<OffsetDateTime> =
        sqlx::query_scalar("SELECT valid_to FROM access_grants WHERE account_id = $1 ORDER BY id")
            .bind(account)
            .fetch_all(&w.owner)
            .await
            .unwrap();
    assert_eq!(before, after);

    let lone: Uuid = sqlx::query_scalar(
        "INSERT INTO employees (org_id, company, name, position, job, source_filename, \
             source_sheet, source_row, source_key, hire_date) VALUES ($1, 'Co', '무계정', '사원', \
             '생산', 'console', 'console', 1, $2, '2025-01-02') RETURNING id",
    )
    .bind(w.org)
    .bind(Uuid::new_v4().to_string())
    .fetch_one(&w.owner)
    .await
    .unwrap();
    w.exit(lone, kst_today()).await.unwrap();
}
