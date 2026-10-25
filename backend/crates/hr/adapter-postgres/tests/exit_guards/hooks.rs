// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;
use console_hr_application::lifecycle::hooks::{LifecycleApplyEvent, LifecycleApplyHooks};
use console_kernel_core::KernelError;
struct Refuse;
impl LifecycleApplyHooks<sqlx::Transaction<'_, sqlx::Postgres>> for Refuse {
    async fn before_apply(
        &self,
        _: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        _: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Err(KernelError::conflict("protected").with_code("exit_protected_period"))
    }
    async fn after_apply(
        &self,
        _: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        _: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Ok(())
    }
    async fn on_rescind(
        &self,
        _: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        _: &LifecycleApplyEvent<'_>,
    ) -> Result<(), KernelError> {
        Ok(())
    }
}
#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn a_coded_before_apply_refusal_keeps_its_code(pool: PgPool) {
    use console_hr_adapter_postgres::lifecycle::{
        normalize::normalize_lifecycle_transition, prepare::prepare_lifecycle_event,
        record::apply_lifecycle_head,
    };
    let w = live(&pool).await;
    let error=console_platform_db::with_org_conn::<_,_,HrError>(&pool,OrgId::from_uuid(w.org),move |tx| Box::pin(async move {
        let transition=normalize_lifecycle_transition(serde_json::from_value(json!({"event_type":"PROMOTE","to_position":"과장","effective_date":"2026-10-10","comment":"합성","signoffs":acks()})).unwrap())?;
        let prepared=prepare_lifecycle_event(tx,w.org,w.in_a,transition,date!(2026-10-21)).await?;
        apply_lifecycle_head(tx,&Refuse,w.org,Uuid::new_v4(),w.hr_one,w.in_a,&prepared.transition,&prepared.target).await
    })).await.unwrap_err();
    assert_eq!(
        (error.status.as_u16(), error.code),
        (409, "exit_protected_period")
    );
}

#[sqlx::test(migrator = "console_platform_test_support::MIGRATOR")]
async fn group_transfer_still_opens_its_settlement_case_during_maternity(pool: PgPool) {
    use console_hr_adapter_postgres::exits::{
        group_transfer_case::open_settlement_case, hooks::ExitLifecycleHooks,
    };
    let w = live(&pool).await;
    leave(&w, w.in_a, "MATERNITY", "2026-10-09", Some("2027-01-01")).await;
    let (org, employee, actor, branch, event) = (
        OrgId::from_uuid(w.org),
        w.in_a,
        w.hr(w.hr_one).user_id,
        Some(w.branch_a),
        Uuid::new_v4(),
    );
    sqlx::query("INSERT INTO employee_lifecycle_events (id,org_id,employee_id,event_type,from_status,to_status,effective_date,comment,created_by,state) VALUES ($1,$2,$3,'GROUP_TRANSFER','ON_LEAVE','ON_LEAVE','2026-10-10','합성 전적',$4,'APPLIED')").bind(event).bind(org.as_uuid()).bind(employee).bind(actor.as_uuid()).execute(&pool).await.unwrap();
    let runtime = console_platform_test_support::runtime_role_pool(&pool).await;
    let case = console_platform_db::with_audits::<_, _, HrError>(&runtime, org, move |tx| {
        Box::pin(async move {
            ExitLifecycleHooks
                .before_apply(
                    tx.as_mut(),
                    &LifecycleApplyEvent {
                        org_id: org,
                        event_id: event,
                        employee_id: employee,
                        event_type: "GROUP_TRANSFER",
                        effective_date: date!(2026 - 10 - 10),
                    },
                )
                .await
                .map_err(console_hr_adapter_postgres::lifecycle::title_reason::coded)?;
            let (case, audit) = open_settlement_case(
                tx,
                (org, actor),
                (employee, event, branch),
                date!(2026 - 10 - 10),
                "합성 전적",
            )
            .await?;
            Ok((case, vec![audit]))
        })
    })
    .await
    .unwrap();
    let row: (String, Option<String>) =
        sqlx::query_as("SELECT status,exit_reason_code FROM employee_exit_cases WHERE id=$1")
            .bind(case)
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(row, ("HR_CONFIRMED".into(), Some("GROUP_TRANSFER".into())));
    assert_eq!(sqlx::query_scalar::<_,i64>("SELECT count(*) FROM employee_lifecycle_events WHERE org_id=$1 AND event_type='TERMINATE'").bind(org.as_uuid()).fetch_one(&pool).await.unwrap(),0);
}
