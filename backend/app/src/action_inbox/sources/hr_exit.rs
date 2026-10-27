//! Exit work reuses the record's action, scope, own-record and HQ policy gates.

use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
    page_source_items,
};
use console_hr_adapter_postgres::authz::{
    authorize_hr_case, authorize_hr_scoped, authorize_hr_scoped_write, exit_hq_second_person,
    holds_scoped,
};
use console_hr_adapter_postgres::own_record::{OwnRecord, own_record_decision};
use console_hr_adapter_postgres::{HrError, exits::settlement_deadlines};
use console_kernel_core::KernelError;
use console_platform_authz::{Action, Feature, Principal, authorize_capability};
use console_platform_db::with_org_conn;
use console_settings_adapter_postgres::approval_routes_in_tx;
use console_settings_domain::SettingKey;
use sqlx::PgPool;
use time::{Date, OffsetDateTime, PrimitiveDateTime, Time, macros::offset};
use uuid::Uuid;

#[derive(sqlx::FromRow)]
struct Exit {
    id: Uuid,
    employee_id: Uuid,
    branch_id: Option<Uuid>,
    name: String,
    site: Option<String>,
    status: String,
    exit_date: Date,
    hr_confirmed_by: Option<Uuid>,
    created_at: OffsetDateTime,
}

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
    register: &super::super::request_register::Register,
) -> Result<ActionInboxSourcePage, KernelError> {
    if authorize_hr_scoped(principal, Feature::EmployeeDirectoryRead).is_err()
        || ![
            Feature::ExitCaseHrConfirm,
            Feature::ExitCaseHqConfirm,
            Feature::ExitSettlementManage,
        ]
        .into_iter()
        .any(|f| {
            holds_scoped(principal, f) || authorize_capability(principal, Action::new(f)).is_ok()
        })
    {
        return Ok(super::super::empty_source_page());
    }
    let reader = principal.clone();
    let org = reader.org_id;
    let as_of = query.as_of;
    let register = register.clone();
    let (rows, total, register) = with_org_conn::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move {
            let routed = approval_routes_in_tx(tx.as_mut(), org, SettingKey::ApprovalPolicyExit)
                .await.map_err(HrError::from_kernel)?;
            let candidates = sqlx::query_as::<_, Exit>(
                "SELECT c.id, c.employee_id, c.branch_id, e.name, e.worksite_name AS site, c.status, \
                 c.effective_exit_date AS exit_date, c.hr_confirmed_by, c.created_at \
                 FROM employee_exit_cases c JOIN person_employees_current e ON e.org_id = c.org_id AND e.id = c.employee_id \
                 LEFT JOIN employee_lifecycle_events l ON l.org_id = c.org_id AND l.id = c.exit_lifecycle_event_id \
                 WHERE c.org_id = $1 AND c.created_at <= $2 \
                   AND c.status IN ('REPORTED','HR_CONFIRMED','HQ_CONFIRMED','SETTLEMENT_READY','APPROVAL_DRAFTED') \
                   AND l.state IS DISTINCT FROM 'APPLY_FAILED' ORDER BY c.created_at, c.id"
            ).bind(org.as_uuid()).bind(as_of).fetch_all(tx.as_mut()).await?;
            // Only a caller's own records need the own-record overlay; the owner
            // helper remains the authority for its sole-holder exception.
            let own_records: Vec<Uuid> = sqlx::query_scalar(
                "SELECT e.id FROM users u JOIN employees e ON e.org_id = u.org_id \
                 LEFT JOIN employee_person_bindings s ON s.org_id = e.org_id AND s.employee_id = e.id \
                 LEFT JOIN employee_person_bindings m ON m.org_id = u.org_id AND m.employee_id = u.employee_id \
                 WHERE u.org_id = $1 AND u.id = $2 AND (e.id = u.employee_id \
                    OR s.person_id = m.person_id OR s.person_id = u.employee_id)"
            ).bind(org.as_uuid()).bind(reader.user_id.as_uuid()).fetch_all(tx.as_mut()).await?;
            let mut visible = Vec::new();
            for row in candidates {
                let (feature, kind) = match row.status.as_str() {
                    "REPORTED" => (Feature::ExitCaseHrConfirm, "hr_exit_confirm"),
                    "HR_CONFIRMED" => (Feature::ExitCaseHqConfirm, "hr_exit_confirm_hq"),
                    _ => (Feature::ExitSettlementManage, "hr_exit_settle"),
                };
                if authorize_hr_scoped_write(&reader, Feature::EmployeeDirectoryRead, row.branch_id).is_err() {
                    continue;
                }
                let allowed = if feature == Feature::ExitCaseHrConfirm {
                    match authorize_hr_case(tx, &reader, feature, row.branch_id, row.employee_id).await {
                        Ok(()) => true,
                        Err(error) if matches!(error.status.as_u16(), 403 | 404) => false,
                        Err(error) => return Err(error),
                    }
                } else {
                    authorize_hr_scoped_write(&reader, feature, row.branch_id).is_ok()
                };
                if !allowed {
                    continue;
                }
                if kind == "hr_exit_confirm_hq"
                    && exit_hq_second_person(
                        &row.status,
                        row.hr_confirmed_by,
                        *reader.user_id.as_uuid(),
                        routed,
                        reader.is_tenant_ops,
                    ).is_err() {
                    continue;
                }
                if own_records.contains(&row.employee_id)
                    && own_record_decision(tx, org, reader.user_id, row.employee_id, feature).await? == OwnRecord::Refused
                {
                    continue;
                }
                visible.push((row, kind));
            }
            let total = visible.len();
            let register = if visible.iter().any(|(_, kind)| *kind == "hr_exit_settle") {
                Some(super::super::request_register::get_in(tx.as_mut(), &register).await.map_err(HrError::from_kernel)?)
            } else {
                None
            };
            Ok((visible, total, register))
        })
    }).await.map_err(|error| super::super::source_failure("hr_exit", error.message))?;
    let mut items = Vec::new();
    for (row, kind) in rows {
        let due = if let Some(register) = register.as_ref().filter(|_| kind == "hr_exit_settle") {
            // Reuse the case read's clocks over the exit dates already loaded in the batch.
            settlement_deadlines(&row.exit_date.to_string(), register)
                .map_err(|error| super::super::source_failure("hr_exit", error.message))?
                .into_iter()
                .filter_map(|deadline| deadline.due_date)
                .filter_map(|date| console_hr_domain::text::parse_yyyy_mm_dd(&date).ok())
                .min()
        } else {
            Some(row.exit_date)
        };
        items.push(ActionInboxSourceItem {
            context: None,
            id: format!("hr_exit:{}", row.id),
            kind: kind.into(),
            ref_code: row.exit_date.to_string(),
            title: row.name,
            site: row.site,
            who: None,
            due: due.map(|date| {
                PrimitiveDateTime::new(date, Time::MAX - time::Duration::nanoseconds(999))
                    .assume_offset(offset!(+9))
            }),
            submitted: None,
            links: vec![
                ActionInboxLink {
                    kind: "exit_case".into(),
                    id: row.id.to_string(),
                    label: None,
                },
                ActionInboxLink {
                    kind: "employee".into(),
                    id: row.employee_id.to_string(),
                    label: None,
                },
            ],
            created_at: row.created_at,
        });
    }
    let (items, has_more) = page_source_items(items, &query);
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact: true,
        has_more,
    })
}

#[cfg(all(test, feature = "test-postgres"))]
#[path = "../../../tests/inbox_exit_scale/mod.rs"]
mod scale_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use console_kernel_core::{BranchScope, OrgId, UserId};
    #[cfg(feature = "test-postgres")]
    use console_platform_authz::Role;
    #[cfg(feature = "test-postgres")]
    use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
    use std::collections::BTreeSet;
    use time::OffsetDateTime;

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn exit_inbox_preserves_every_home_forward_step_and_omits_closed_cases(pool: PgPool) {
        let org = OrgId::new();
        let me = seed_org_and_super_admin(&pool, *org.as_uuid(), "inbox-exit").await;
        let principal = Principal::new(
            me,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        for status in [
            "REPORTED",
            "HR_CONFIRMED",
            "HQ_CONFIRMED",
            "SETTLEMENT_READY",
            "APPROVAL_DRAFTED",
            "SUBMITTED",
            "REJECTED",
            "CANCELLED",
        ] {
            let employee: Uuid = sqlx::query_scalar(
                "INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) \
                 VALUES ($1,'회사','김직원','console','console',1,$2) RETURNING id"
            ).bind(org.as_uuid()).bind(Uuid::new_v4().to_string()).fetch_one(&pool).await.unwrap();
            sqlx::query(
                "INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by,hr_confirmed_by) \
                 VALUES ($1,$2,$3,CURRENT_DATE,'업무함 검증',$4,$4)"
            ).bind(org.as_uuid()).bind(employee).bind(status).bind(me.as_uuid()).execute(&pool).await.unwrap();
        }
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let actual = page(
            &runtime_role_pool(&pool).await,
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
        .await
        .unwrap();
        assert_eq!(actual.total, 5);
        for (kind, count) in [
            ("hr_exit_confirm", 1),
            ("hr_exit_confirm_hq", 1),
            ("hr_exit_settle", 3),
        ] {
            assert_eq!(
                actual.items.iter().filter(|i| i.kind == kind).count(),
                count,
                "{kind}"
            );
        }
        assert!(
            actual
                .items
                .iter()
                .all(|i| i.id.starts_with("hr_exit:") && i.links[0].kind == "exit_case")
        );
        let denied = Principal::new(me, org, BTreeSet::new(), BranchScope::All);
        let no_items = page(
            &runtime_role_pool(&pool).await,
            &denied,
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
        .await
        .unwrap();
        assert_eq!(no_items.total, 0);
    }

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn routed_hq_work_keeps_the_ops_break_glass_path_without_admitting_same_actor_hr(
        pool: PgPool,
    ) {
        let org = OrgId::new();
        let me = seed_org_and_super_admin(&pool, *org.as_uuid(), "inbox-exit-ops").await;
        sqlx::query("INSERT INTO tenant_setting_overrides (org_id,key,value,set_by,reason_code) VALUES ($1,'approval.policy.exit','\"route\"',$2,'BW01')")
            .bind(org.as_uuid()).bind(me.as_uuid()).execute(&pool).await.unwrap();
        let employee: Uuid = sqlx::query_scalar(
            "INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) \
             VALUES ($1,'회사','김직원','console','console',1,'inbox-exit-ops') RETURNING id"
        ).bind(org.as_uuid()).fetch_one(&pool).await.unwrap();
        let case: Uuid = sqlx::query_scalar(
            "INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by,hr_confirmed_by) \
             VALUES ($1,$2,'HR_CONFIRMED',CURRENT_DATE,'업무함 검증',$3,$3) RETURNING id"
        ).bind(org.as_uuid()).bind(employee).bind(me.as_uuid()).fetch_one(&pool).await.unwrap();
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let query = ActionInboxSourceQuery {
            filter: Default::default(),
            require_exact_total: false,
            now,
            as_of: now,
            after: None,
            limit: 20,
        };
        let principal = Principal::new(
            me,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let runtime = runtime_role_pool(&pool).await;
        let denied = page(&runtime, &principal, query.clone(), &Default::default())
            .await
            .unwrap();
        assert!(
            denied.items.is_empty(),
            "ordinary HR cannot confirm their own HQ tier"
        );
        assert_eq!(denied.total, 0);
        sqlx::query("UPDATE users SET is_tenant_ops=true WHERE org_id=$1 AND id=$2")
            .bind(org.as_uuid())
            .bind(me.as_uuid())
            .execute(&pool)
            .await
            .unwrap();
        let allowed = page(
            &runtime,
            &principal.with_tenant_ops(true),
            query,
            &Default::default(),
        )
        .await
        .unwrap();
        assert_eq!(
            allowed.total, 1,
            "ops can resolve the HQ tier after passkey step-up"
        );
        assert_eq!(allowed.items.len(), 1);
        assert_eq!(allowed.items[0].kind, "hr_exit_confirm_hq");
        assert_eq!(allowed.items[0].id, format!("hr_exit:{case}"));
    }

    #[tokio::test]
    async fn no_exit_grant_does_not_query_or_disclose_a_source() {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .connect_lazy("postgres://unused:unused@127.0.0.1:1/unused")
            .unwrap();
        let principal = Principal::new(
            UserId::new(),
            OrgId::new(),
            BTreeSet::new(),
            BranchScope::All,
        );
        let now = OffsetDateTime::now_utc();
        let result = page(
            &pool,
            &principal,
            ActionInboxSourceQuery {
                filter: Default::default(),
                require_exact_total: false,
                now,
                as_of: now,
                after: None,
                limit: 10,
            },
            &Default::default(),
        )
        .await
        .unwrap();
        assert!(result.items.is_empty());
        assert_eq!(result.total, 0);
    }
}
