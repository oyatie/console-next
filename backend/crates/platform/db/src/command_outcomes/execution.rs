//! An unreturned capability owns continuation of this HTTP attempt, not a retry.
use crate::{DbError, command_context, with_org_conn};
use console_kernel_core::OrgId;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

pub async fn claim(pool: &PgPool, org: OrgId, id: Uuid) -> Result<Option<Uuid>, DbError> {
    let token = Uuid::new_v4();
    with_org_conn(pool,org,move |tx|Box::pin(async move {
        Ok(sqlx::query_scalar("UPDATE command_outcomes SET execution_token=$2 WHERE id=$1 AND state='PROCESSING' AND execution_token IS NULL AND deadline>clock_timestamp() RETURNING execution_token")
            .bind(id).bind(token).fetch_optional(tx.as_mut()).await?)
    })).await
}
/// Existing payload-bound employee creation can finish its isolated routing step.
pub async fn resume_employee_routing(
    pool: &PgPool,
    org: OrgId,
    id: Uuid,
) -> Result<Option<Uuid>, DbError> {
    let token = Uuid::new_v4();
    with_org_conn(pool,org,move |tx|Box::pin(async move {
        sqlx::query("SELECT set_config('app.command_execution',$1,true)").bind(token.to_string()).execute(tx.as_mut()).await?;
        Ok(sqlx::query_scalar("UPDATE command_outcomes c SET execution_token=$2 WHERE c.org_id=$3 AND c.id=$1 AND c.state='APPLIED' AND c.execution_token IS NULL AND c.result IS NULL AND c.response_status IS NULL AND c.command='POST /api/v1/employees' AND c.deadline>clock_timestamp() AND EXISTS(SELECT 1 FROM audit_events e JOIN employees p ON p.org_id=e.org_id AND p.id::TEXT=e.target_id WHERE e.org_id=c.org_id AND e.command_id=c.id AND e.actor=c.actor_id AND e.action='employee.create' AND p.home_branch_id IS NULL) RETURNING c.execution_token")
            .bind(id).bind(token).bind(org.as_uuid()).fetch_optional(tx.as_mut()).await?)
    })).await
}
pub async fn bind(tx: &mut Transaction<'_, Postgres>) -> Result<(), DbError> {
    if command_context::current().is_none_or(|c| c.command_id.is_none())
        && command_context::execution().is_none()
    {
        return Ok(());
    }
    let bound:Option<String>=sqlx::query_scalar("SELECT current_setting('app.current_org',true) FROM (SELECT set_config('app.command_execution',$1,true)) binding")
        .bind(command_context::execution().map(|id|id.to_string()).unwrap_or_default()).fetch_one(tx.as_mut()).await?;
    let context = command_context::current().map(|mut context| {
        if context.org_id.is_none() {
            context.org_id = bound
                .as_deref()
                .and_then(|s| Uuid::parse_str(s).ok())
                .map(OrgId::from_uuid);
        }
        for (key, version) in crate::audit_snapshot::default_versions() {
            context
                .decision_snapshot
                .entry(key.clone())
                .or_insert_with(|| version.clone());
        }
        context
    });
    sqlx::query("SELECT set_config('app.audit_command',$1,true)")
        .bind(
            context
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?
                .unwrap_or_default(),
        )
        .execute(tx.as_mut())
        .await?;
    Ok(())
}
/// No APPLIED row is reopened. A definitively finished, unapplied attempt may retry.
pub async fn finish(
    pool: &PgPool,
    org: OrgId,
    id: Uuid,
    result: Option<Value>,
    status: Option<i16>,
) -> Result<(), DbError> {
    let Some(token) = command_context::execution() else {
        return Ok(());
    };
    with_org_conn(pool,org,move |tx|Box::pin(async move {
        bind(tx).await?;
        sqlx::query("UPDATE command_outcomes SET execution_token=NULL,result=CASE WHEN state='APPLIED' THEN CASE WHEN $4::smallint IS NULL THEN NULL ELSE COALESCE($3::jsonb,result) END ELSE result END,response_status=CASE WHEN state='APPLIED' THEN $4 ELSE response_status END WHERE id=$1 AND execution_token=$2")
            .bind(id).bind(token).bind(result).bind(status).execute(tx.as_mut()).await?;
        Ok(())
    })).await
}
