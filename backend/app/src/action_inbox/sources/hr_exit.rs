//! Exit work reuses the record's action, scope, own-record and HQ policy gates.

use console_action_inbox_application::{
    ActionInboxLink, ActionInboxSourceItem, ActionInboxSourcePage, ActionInboxSourceQuery,
    page_source_items,
};
use console_hr_adapter_postgres::authz::{HrCaseFacts, exit_hq_second_person};
use console_hr_adapter_postgres::own_record::{OwnRecord, own_record_decision};
use console_hr_adapter_postgres::{HrError, exits::settlement_deadlines};
use console_kernel_core::KernelError;
use console_platform_authz::cedar_pbac::visible::load_facts;
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_org_conn;
use console_settings_adapter_postgres::approval_routes_in_tx;
use console_settings_domain::SettingKey;
use sqlx::PgPool;
use time::{Date, OffsetDateTime};
use uuid::Uuid;

#[path = "hr_exit_query.rs"]
mod read;

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
    due: Option<OffsetDateTime>,
}

pub(crate) async fn page(
    pool: &PgPool,
    principal: &Principal,
    query: ActionInboxSourceQuery,
    register: &super::super::request_register::Register,
) -> Result<ActionInboxSourcePage, KernelError> {
    let reader = principal.clone();
    let org = reader.org_id;
    let input = query.clone();
    let register = register.clone();
    let (rows, exhausted) = with_org_conn::<_, _, HrError>(pool, org, move |tx| {
        Box::pin(async move {
            let routed = approval_routes_in_tx(tx.as_mut(), org, SettingKey::ApprovalPolicyExit)
                .await
                .map_err(HrError::from_kernel)?;
            let register = super::super::request_register::get_in(tx.as_mut(), &register)
                .await
                .map_err(HrError::from_kernel)?;
            let bands = read::deadline_bands(&register)?;
            let decisions = tokio::sync::OnceCell::new();
            let mut visible = Vec::new();
            let mut scan = input.clone();
            let mut exhausted = false;
            while visible.len() <= input.limit {
                let candidates = read::candidates(tx, &reader, &bands, &scan).await?;
                let last_batch = candidates.len() <= scan.limit;
                if candidates.is_empty() {
                    exhausted = true;
                    break;
                }
                let ids: Vec<_> = candidates.iter().map(|c| c.employee_id).collect();
                let resources = HrCaseFacts::load(tx, *reader.user_id.as_uuid(), &ids).await?;
                let facts = decisions
                    .get_or_try_init(|| load_facts(tx, org, *reader.user_id.as_uuid()))
                    .await
                    .map_err(HrError::from_kernel)?;
                for row in candidates {
                    scan.after = Some(console_action_inbox_application::ActionInboxPosition {
                        due: row.due,
                        created_at: row.created_at,
                        id: format!("hr_exit:{}", row.id),
                    });
                    let (feature, kind) = match row.status.as_str() {
                        "REPORTED" => (Feature::ExitCaseHrConfirm, "hr_exit_confirm"),
                        "HR_CONFIRMED" => (Feature::ExitCaseHqConfirm, "hr_exit_confirm_hq"),
                        _ => (Feature::ExitSettlementManage, "hr_exit_settle"),
                    };
                    if !resources.readable(facts, org, row.employee_id)? {
                        continue;
                    }
                    match resources.authorize(&reader, feature, row.branch_id, row.employee_id) {
                        Ok(()) => {}
                        Err(error) if matches!(error.status.as_u16(), 403 | 404) => continue,
                        Err(error) => return Err(error),
                    }
                    if kind == "hr_exit_confirm_hq"
                        && exit_hq_second_person(
                            &row.status,
                            row.hr_confirmed_by,
                            *reader.user_id.as_uuid(),
                            routed,
                            reader.is_tenant_ops,
                        )
                        .is_err()
                    {
                        continue;
                    }
                    if resources.is_own(row.employee_id)
                        && own_record_decision(tx, org, reader.user_id, row.employee_id, feature)
                            .await?
                            == OwnRecord::Refused
                    {
                        continue;
                    }
                    visible.push((row, kind));
                    if visible.len() > input.limit {
                        break;
                    }
                }
                if last_batch {
                    exhausted = true;
                    break;
                }
            }
            Ok((visible, exhausted))
        })
    })
    .await
    .map_err(|error| super::super::source_failure("hr_exit", error.message))?;
    let mut items = Vec::new();
    for (row, kind) in rows {
        items.push(ActionInboxSourceItem {
            context: None,
            id: format!("hr_exit:{}", row.id),
            kind: kind.into(),
            ref_code: row.exit_date.to_string(),
            title: row.name,
            site: row.site,
            who: None,
            due: row.due,
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
    let total = items.len();
    let (items, has_more) = page_source_items(items, &query);
    Ok(ActionInboxSourcePage {
        items,
        total,
        total_is_exact: exhausted && !has_more && query.after.is_none(),
        has_more,
    })
}

#[cfg(all(test, feature = "test-postgres"))]
#[path = "../../../tests/inbox_exit_scale/mod.rs"]
mod scale_tests;

#[cfg(test)]
mod tests {
    #![cfg(feature = "test-postgres")]

    use super::*;
    use console_kernel_core::{BranchScope, OrgId};
    #[cfg(feature = "test-postgres")]
    use console_platform_authz::Role;
    #[cfg(feature = "test-postgres")]
    use console_platform_test_support::{runtime_role_pool, seed_org_and_super_admin};
    use std::collections::BTreeSet;

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn exit_inbox_preserves_every_home_forward_step_and_omits_closed_cases(pool: PgPool) {
        let org = OrgId::new();
        let me = seed_org_and_super_admin(&pool, *org.as_uuid(), "inbox-exit").await;
        scale_tests::grant_exit(&pool, org, me).await;
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
        let outsider = console_platform_test_support::seed_active_user(
            &pool,
            *org.as_uuid(),
            "MEMBER",
            "exit-denied",
        )
        .await;
        let denied = Principal::new(outsider, org, BTreeSet::new(), BranchScope::All);
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
        scale_tests::grant_exit(&pool, org, me).await;
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

    #[cfg(feature = "test-postgres")]
    #[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
    async fn legacy_role_without_cedar_grants_does_not_disclose_exit_work(pool: PgPool) {
        let org = OrgId::new();
        let actor = seed_org_and_super_admin(&pool, *org.as_uuid(), "exit-denied").await;
        sqlx::query(
            "WITH p AS (INSERT INTO employees (org_id,company,name,source_filename,source_sheet,source_row,source_key) \
             VALUES ($1,'회사','김직원','console','console',1,'denied') RETURNING id) \
             INSERT INTO employee_exit_cases (org_id,employee_id,status,effective_exit_date,site_manager_note,reported_by) \
             SELECT $1,id,'REPORTED',CURRENT_DATE,'검증',$2 FROM p"
        ).bind(org.as_uuid()).bind(actor.as_uuid()).execute(&pool).await.unwrap();
        let principal = Principal::new(
            actor,
            org,
            BTreeSet::from([Role::SuperAdmin]),
            BranchScope::All,
        );
        let now = sqlx::query_scalar("SELECT clock_timestamp()")
            .fetch_one(&pool)
            .await
            .unwrap();
        let result = page(
            &runtime_role_pool(&pool).await,
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
