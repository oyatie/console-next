//! Durable command identity and settlement. APPLIED and audit references share
//! the business transaction; a cancelled response never undoes that fact.
use crate::{DbError, command_context, with_org_conn};
use console_kernel_core::{AuditEvent, OrgId, UserId};
use serde::Serialize;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Row, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

#[path = "command_outcomes/execution.rs"]
pub mod execution;

pub const INVALID_REQUEST_KEY_CODE: &str = "invalid_request_key";
pub const REQUEST_NOT_FOUND_CODE: &str = "request_not_found";
pub const COMMAND_PROCESSING_CODE: &str = "command_processing";
pub const COMMAND_APPLIED_CODE: &str = "command_applied";
pub const COMMAND_SETTLED_CODE: &str = "command_settled";
pub const COMMAND_EXPIRED_CODE: &str = "command_expired";

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct CommandOutcome {
    pub id: Uuid,
    #[serde(skip_serializing)]
    pub org_id: Uuid,
    #[serde(skip_serializing)]
    pub actor_id: Uuid,
    pub idempotency_key: String,
    pub command: String,
    pub state: String,
    #[serde(with = "time::serde::rfc3339::option")]
    pub deadline: Option<OffsetDateTime>,
    pub inputs_masked: Value,
    pub result: Option<Value>,
    #[serde(skip_serializing)]
    pub response_status: Option<i16>,
    pub touched: Value,
    pub refusal_code: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option")]
    pub settled_at: Option<OffsetDateTime>,
}
#[derive(Debug)]
pub enum Reservation {
    Fresh(Uuid),
    Existing(Box<CommandOutcome>),
    Mismatch(Uuid),
}
const COLUMNS: &str = "id,org_id,actor_id,idempotency_key,command,state,deadline,inputs_masked,CASE WHEN execution_token IS NULL THEN result ELSE NULL END AS result,response_status,touched,refusal_code,created_at,settled_at";

pub async fn reserve(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    key: String,
    command: String,
    fingerprint: Vec<u8>,
    masked: Value,
) -> Result<Reservation, DbError> {
    with_org_conn(pool, org, move |tx| Box::pin(async move {
        let inserted: Option<Uuid> = sqlx::query_scalar("INSERT INTO command_outcomes (org_id,actor_id,idempotency_key,command,request_fingerprint,inputs_masked) VALUES ($1,$2,$3,$4,encode(sha256($5::bytea),'hex'),$6) ON CONFLICT (org_id,actor_id,command,idempotency_key) DO NOTHING RETURNING id")
            .bind(org.as_uuid()).bind(actor.as_uuid()).bind(&key).bind(&command).bind(&fingerprint).bind(masked).fetch_optional(tx.as_mut()).await?;
        if let Some(id) = inserted {
            let mut context=command_context::current().unwrap_or_else(||console_kernel_core::AuditCommandContext::for_actor(Some(actor)));
            context.command_id=Some(id);
            let event=AuditEvent::new(Some(actor),console_kernel_core::AuditAction::new("command.received").map_err(|e|DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?,"command_outcome",id.to_string(),console_kernel_core::TraceContext::generate(),OffsetDateTime::now_utc()).with_org(org).with_command_context(context);
            crate::insert_audit_event(tx,&event).await?;
            return Ok(Reservation::Fresh(id));
        }
        let row = sqlx::query("SELECT id, request_fingerprint = encode(sha256($4::bytea),'hex') AND command = $5 AS same FROM command_outcomes WHERE org_id=$1 AND actor_id=$2 AND idempotency_key=$3 AND command=$5")
            .bind(org.as_uuid()).bind(actor.as_uuid()).bind(&key).bind(&fingerprint).bind(&command).fetch_one(tx.as_mut()).await?;
        let id: Uuid = row.try_get("id")?;
        if !row.try_get::<bool,_>("same")? { return Ok(Reservation::Mismatch(id)); }
        Ok(Reservation::Existing(Box::new(load_in_tx(tx,id).await?)))
    })).await
}
pub async fn load_in_tx(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<CommandOutcome, DbError> {
    let query = format!("SELECT {COLUMNS} FROM command_outcomes WHERE id=$1");
    Ok(sqlx::query_as(sqlx::AssertSqlSafe(query))
        .bind(id)
        .fetch_one(tx.as_mut())
        .await?)
}
pub async fn lookup(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    key: String,
) -> Result<Option<CommandOutcome>, DbError> {
    with_org_conn(pool,org,move |tx| Box::pin(async move {
        let operation_id = Uuid::parse_str(&key).ok();
        let query = format!("SELECT {COLUMNS} FROM command_outcomes WHERE org_id=$1 AND (id=$2 OR idempotency_key=$3) ORDER BY (id=$2) DESC NULLS LAST,(actor_id=$4) DESC,created_at DESC LIMIT 2");
        let rows = sqlx::query_as(sqlx::AssertSqlSafe(query)).bind(org.as_uuid()).bind(operation_id).bind(key).bind(actor.as_uuid()).fetch_all(tx.as_mut()).await?;
        // A key shared by different actors is ambiguous; expose neither.
        Ok(if rows.first().is_some_and(|r: &CommandOutcome|Some(r.id)==operation_id) || rows.len()==1 || (rows.first().is_some_and(|r: &CommandOutcome|r.actor_id==*actor.as_uuid()) && rows.get(1).is_some_and(|r|r.actor_id!=*actor.as_uuid())) { rows.into_iter().next() } else { None })
    })).await
}
/// Lock before mutation. Concurrent requests already wait at the reservation.
pub async fn lock_current(tx: &mut Transaction<'_, Postgres>) -> Result<(), DbError> {
    execution::bind(tx).await?;
    if let Some(id) = command_context::current().and_then(|c| c.command_id) {
        let admitted: bool = sqlx::query_scalar("SELECT COALESCE((state='PROCESSING' AND (execution_token IS NOT DISTINCT FROM $2) AND (deadline IS NULL OR deadline>clock_timestamp())) OR (state='APPLIED' AND execution_token=$2 AND deadline>clock_timestamp()),false) FROM command_outcomes WHERE id=$1 FOR UPDATE")
            .bind(id).bind(command_context::execution()).fetch_one(tx.as_mut()).await?;
        if !admitted {
            return Err(DbError::Sqlx(sqlx::Error::Protocol(
                "command has already settled".into(),
            )));
        }
    }
    Ok(())
}
/// Domain callers may provide their safe replayable result before settlement.
pub async fn set_result(tx: &mut Transaction<'_, Postgres>, result: &Value) -> Result<(), DbError> {
    if let Some(id) = command_context::current().and_then(|c| c.command_id) {
        sqlx::query("UPDATE command_outcomes SET result=$2 WHERE id=$1 AND (state='PROCESSING' OR (state='APPLIED' AND execution_token=$3))")
            .bind(id)
            .bind(result)
            .bind(command_context::execution())
            .execute(tx.as_mut())
            .await?;
    }
    Ok(())
}
pub async fn settle_applied(
    tx: &mut Transaction<'_, Postgres>,
    events: &[AuditEvent],
) -> Result<(), DbError> {
    let Some(id) = command_context::current().and_then(|c| c.command_id) else {
        return Ok(());
    };
    // Credential/step-up consumption is preflight, not the governed mutation.
    let touched: Vec<Value> = events.iter().filter(|e| !e.action.as_str().ends_with(".read") && !e.action.as_str().ends_with("_read") && !e.action.as_str().contains("step_up") && !e.action.as_str().ends_with(".refused") && !e.action.as_str().ends_with(".denied") && !e.action.as_str().ends_with("_refused"))
        .filter(|e| e.command_context.as_ref().is_none_or(|c| c.outcome == console_kernel_core::AuditOutcome::Allowed))
        .map(|e| json!({"type":e.target_type,"id":e.target_id,"audit_id":e.id,"branch_id":e.branch_id})).collect();
    if touched.is_empty() {
        return Ok(());
    }
    sqlx::query("UPDATE command_outcomes c SET state='APPLIED',touched=(SELECT COALESCE(jsonb_agg(jsonb_build_object('type',e.target_type,'id',e.target_id,'audit_id',e.id,'branch_id',e.branch_id) ORDER BY e.created_at,e.id),'[]') FROM audit_events e WHERE e.command_id=$1 AND e.org_id=c.org_id AND e.outcome='ALLOWED' AND e.action NOT IN ('command.received','command.refused') AND e.action !~ '(\\.read$|_read$|\\.refused$|_refused$|\\.denied$|step_up)'),settled_at=now() WHERE id=$1 AND state='PROCESSING'").bind(id).execute(tx.as_mut()).await?;
    Ok(())
}
/// A terminal refusal and its negative audit share one transaction, after rollback.
pub async fn settle_refused(
    pool: &PgPool,
    org: OrgId,
    id: Uuid,
    state: String,
    code: String,
    event: AuditEvent,
) -> Result<(), DbError> {
    with_org_conn(pool,org,move |tx| Box::pin(async move {
        let changed = sqlx::query("UPDATE command_outcomes SET state=$2,refusal_code=$3,settled_at=now(),execution_token=NULL WHERE id=$1 AND state='PROCESSING'").bind(id).bind(state).bind(code).execute(tx.as_mut()).await?;
        let active_partial=if let Some(token)=command_context::execution() {
            sqlx::query_scalar::<_,bool>("SELECT COALESCE(state='APPLIED' AND execution_token=$2,false) FROM command_outcomes WHERE id=$1")
                .bind(id).bind(token).fetch_one(tx.as_mut()).await?
        } else {false};
        if changed.rows_affected()==1 || active_partial { crate::insert_audit_event(tx,&event).await?; }
        Ok(())
    })).await
}

pub async fn expire_abandoned(pool: &PgPool, org: OrgId) -> Result<(), DbError> {
    with_org_conn(pool,org,move |tx|Box::pin(async move {
        let ids:Vec<Uuid>=sqlx::query_scalar("SELECT id FROM command_outcomes WHERE org_id=$1 AND state='PROCESSING' AND deadline<=now() ORDER BY deadline,id LIMIT 100 FOR UPDATE SKIP LOCKED")
            .bind(org.as_uuid()).fetch_all(tx.as_mut()).await?;
        for id in ids {
            sqlx::query("UPDATE command_outcomes SET state='EXPIRED',refusal_code=$2,settled_at=now() WHERE id=$1 AND state='PROCESSING'").bind(id).bind(COMMAND_EXPIRED_CODE).execute(tx.as_mut()).await?;
            let mut context=console_kernel_core::AuditCommandContext::for_actor(None);context.command_id=Some(id);context.outcome=console_kernel_core::AuditOutcome::Denied;
            let event=AuditEvent::new(None,console_kernel_core::AuditAction::new("command.expired").map_err(|e|DbError::Sqlx(sqlx::Error::Protocol(e.to_string())))?,"command_outcome",id.to_string(),console_kernel_core::TraceContext::generate(),OffsetDateTime::now_utc()).with_org(org).with_command_context(context);
            crate::insert_audit_event(tx,&event).await?;
        }
        Ok(())
    })).await
}

pub fn valid_lookup_key(key: &str) -> Result<(), &'static str> {
    if crate::idempotency::validate_idempotency_key(Some(key)).is_err() {
        Err(INVALID_REQUEST_KEY_CODE)
    } else {
        Ok(())
    }
}
