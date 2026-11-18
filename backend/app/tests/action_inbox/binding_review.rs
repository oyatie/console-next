// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_action_inbox_application::{ActionInboxPosition, InboxFilter};
use console_kernel_core::{OrgId, UserId};
use console_platform_request_context::scope_org;
use console_platform_test_support::{runtime_role_pool, seed_active_user};
use time::{Duration, OffsetDateTime};
use uuid::Uuid;

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn review_source_keeps_snapshot_totals_deadline_and_cursor_on_its_receipt(
    pool: sqlx::PgPool,
) {
    let org = OrgId::one();
    let mut accounts = Vec::new();
    for name in ["Self-attester", "Reviewer"] {
        let account = seed_active_user(&pool, *org.as_uuid(), "MEMBER", name).await;
        let employee: Uuid = sqlx::query_scalar("INSERT INTO employees(org_id,company,name,source_filename,source_sheet,source_row,source_key,identity_review_required) \
            VALUES($1,'Synthetic',$2,'fixture','fixture',1,gen_random_uuid()::text,false) RETURNING id")
            .bind(org.as_uuid()).bind(name).fetch_one(&pool).await.unwrap();
        if accounts.is_empty() {
            sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
                .bind(account.as_uuid())
                .execute(&pool)
                .await
                .unwrap();
        }
        sqlx::query("UPDATE users SET employee_id=$2,person_id=console_bind_employee_person(org_id,$2,id) WHERE id=$1")
            .bind(account.as_uuid()).bind(employee).execute(&pool).await.unwrap();
        accounts.push((account, employee));
    }
    let (actor, employee) = accounts[0];
    let reviewer: UserId = accounts[1].0;
    let receipt = Uuid::new_v4();
    let now: OffsetDateTime = sqlx::query_scalar("SELECT clock_timestamp()")
        .fetch_one(&pool)
        .await
        .unwrap();
    let due = now + Duration::days(1);
    sqlx::query("INSERT INTO step_up_assertions(ceremony_id,org_id,user_id,credential_row_id,action_kind,object_id,payload_hash,user_verified) \
        VALUES($1,$2,$3,gen_random_uuid(),'EXCEPTION_DECIDE',$3,repeat('a',64),true)")
        .bind(receipt).bind(org.as_uuid()).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO account_link_self_attestations(id,org_id,account_id,employee_id,attested_at,eligibility,review_days,review_due_at) \
        VALUES($1,$2,$3,$4,$5,'{}',1,$6)")
        .bind(receipt).bind(org.as_uuid()).bind(actor.as_uuid()).bind(employee).bind(now).bind(due).execute(&pool).await.unwrap();
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=false WHERE id=$1")
        .bind(actor.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE users SET is_tenant_ops=true WHERE id=$1")
        .bind(reviewer.as_uuid())
        .execute(tx.as_mut())
        .await
        .unwrap();
    sqlx::query("UPDATE users SET person_id=console_bind_employee_person(org_id,employee_id,id) WHERE id=$1")
        .bind(reviewer.as_uuid()).execute(tx.as_mut()).await.unwrap();
    tx.commit().await.unwrap();
    let runtime = runtime_role_pool(&pool).await;
    let principal = Principal::new(
        reviewer,
        org,
        Default::default(),
        console_kernel_core::BranchScope::All,
    );
    let mut query = ActionInboxSourceQuery {
        filter: InboxFilter::Turn,
        require_exact_total: true,
        now,
        as_of: now - Duration::seconds(1),
        after: None,
        limit: 1,
    };
    let hidden = scope_org(org, page(&runtime, &principal, query.clone()))
        .await
        .unwrap();
    assert_eq!(hidden.total, 0);
    assert!(hidden.items.is_empty());
    query.as_of = now;
    let visible = scope_org(org, page(&runtime, &principal, query.clone()))
        .await
        .unwrap();
    assert_eq!(visible.total, 1);
    assert!(visible.total_is_exact);
    assert!(!visible.has_more);
    assert_eq!(visible.items.len(), 1);
    let item = &visible.items[0];
    assert_eq!(item.links[0].id, employee.to_string());
    assert_eq!(item.due, Some(due));
    assert_eq!(
        item.context.as_ref().unwrap()["command_id"],
        receipt.to_string()
    );
    query.after = Some(ActionInboxPosition {
        due: item.due,
        created_at: item.created_at,
        id: item.id.clone(),
    });
    let next = scope_org(org, page(&runtime, &principal, query))
        .await
        .unwrap();
    assert_eq!(next.total, 1);
    assert!(next.items.is_empty());
    assert!(!next.has_more);
}
