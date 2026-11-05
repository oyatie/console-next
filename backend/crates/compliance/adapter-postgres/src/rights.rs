// SPDX-License-Identifier: LicenseRef-Proprietary
//! Self-service request persistence; callers admit through Cedar in this transaction.
use crate::{PgComplianceError, statutory::StatutoryRegister};
use console_compliance_domain::rights::{
    AgentKind, Channel, IdentityMethod, Receipt, RightsRequest,
};
pub use console_compliance_domain::rights::{Controller, Filing, Kind, due};
use console_kernel_core::{
    AuditAction, AuditEvent, KernelError, OrgId, Timestamp, TraceContext, UserId,
};
use console_platform_db::insert_audit_event;
use serde_json::{Value, json};
use sqlx::{PgPool, Postgres, Transaction};
use time::{OffsetDateTime, UtcOffset};
use uuid::Uuid;

pub async fn begin(
    pool: &PgPool,
    org: OrgId,
) -> Result<Transaction<'_, Postgres>, PgComplianceError> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT set_config('app.current_org',$1,true)")
        .bind(org.to_string())
        .execute(tx.as_mut())
        .await?;
    console_platform_db::command_outcomes::execution::bind(&mut tx).await?;
    Ok(tx)
}

pub async fn file(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
    actor: UserId,
    employee: Option<Uuid>,
    input: &Filing,
    register: &StatutoryRegister,
) -> Result<Value, PgComplianceError> {
    let refuse = |code| PgComplianceError::Domain(KernelError::validation(code).with_code(code));
    if input.controller == Controller::Tenant && employee.is_none() {
        return Err(refuse("no_employee_record"));
    }
    if input.detail.chars().count() > detail_max_length(tx, org).await? {
        return Err(refuse("detail_too_long"));
    }
    if input.kinds.iter().any(|kind| !Kind::FILING.contains(kind)) {
        return Err(refuse("request_kind_unavailable"));
    }
    let now = OffsetDateTime::now_utc();
    let today = now
        .to_offset(
            UtcOffset::from_hms(9, 0, 0)
                .map_err(|_| KernelError::internal("KST offset invalid"))?,
        )
        .date();
    let id = Uuid::new_v4();
    let request = RightsRequest::receive(
        Receipt {
            id,
            controller: input.controller,
            channel: Channel::InApp,
            agent: AgentKind::Subject,
            mandate_received: false,
            identity_method: IdentityMethod::Passkey,
            identity_at: now,
            received_on: today,
        },
        input.kinds.iter().copied(),
        register,
        today,
        None,
    )?;
    let mut body =
        serde_json::to_value(&request).map_err(|e| KernelError::internal(e.to_string()))?;
    body["id"] = json!(id);
    body["receipt_no"] = json!(format!("RR-{}", id.simple()));
    body["detail"] = json!(input.detail);
    body["status"] = json!(request.status());
    sqlx::query("INSERT INTO privacy_rights_requests (org_id,id,subject_user_id,subject_employee_id,body) VALUES ($1,$2,$3,$4,$5)")
        .bind(org.as_uuid()).bind(id).bind(actor.as_uuid()).bind(employee).bind(&body).execute(tx.as_mut()).await?;
    let event = AuditEvent::new(
        Some(actor),
        AuditAction::new("privacy_request.received")?,
        "privacy_rights_request",
        id.to_string(),
        TraceContext::generate(),
        Timestamp::now_utc(),
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({"id":id,"controller":input.controller,"kinds":input.kinds})),
    );
    insert_audit_event(tx, &event).await?;
    console_platform_db::command_outcomes::set_result(tx, &body).await?;
    Ok(body)
}

pub async fn mine(
    tx: &mut Transaction<'_, Postgres>,
    actor: UserId,
    cursor: Option<&str>,
    limit: i64,
) -> Result<Value, PgComplianceError> {
    let cursor = cursor
        .map(Uuid::parse_str)
        .transpose()
        .map_err(|_| KernelError::validation("cursor_invalid").with_code("cursor_invalid"))?;
    let mut rows: Vec<(Uuid,Value)> = sqlx::query_as("SELECT id,body FROM privacy_rights_requests WHERE subject_user_id=$1 AND ($2::uuid IS NULL OR id<$2) ORDER BY id DESC LIMIT $3")
        .bind(actor.as_uuid()).bind(cursor).bind(limit + 1).fetch_all(tx.as_mut()).await?;
    let more = rows.len()
        > usize::try_from(limit).map_err(|_| KernelError::validation("limit_invalid"))?;
    if more {
        rows.pop();
    }
    let next = more
        .then(|| rows.last().map(|(id, _)| id.to_string()))
        .flatten();
    Ok(
        json!({"items":rows.into_iter().map(|(_,body)| body).collect::<Vec<_>>(),"next_cursor":next,"as_of":OffsetDateTime::now_utc().to_offset(UtcOffset::from_hms(9,0,0).map_err(|_| KernelError::internal("KST offset invalid"))?).date().to_string()}),
    )
}

/// Canonical filing payload hash for the existing bound passkey verifier.
pub async fn filing_hash(pool: &PgPool, input: &Filing) -> Result<String, PgComplianceError> {
    let payload = serde_json::to_string(input).map_err(|e| KernelError::internal(e.to_string()))?;
    Ok(
        sqlx::query_scalar("SELECT encode(sha256(convert_to($1,'UTF8')),'hex')")
            .bind(payload)
            // rls-arming: ok pure string hashing; no table or tenant data is read
            .fetch_one(pool)
            .await?,
    )
}

/// Shared registry limit for both the preview and authoritative filing validation.
pub async fn detail_max_length(
    tx: &mut Transaction<'_, Postgres>,
    org: OrgId,
) -> Result<usize, PgComplianceError> {
    use console_platform_db::settings_read::{SettingKey, resolve_in_tx};
    let key = SettingKey::PrivacyRightsDetailMaxLength;
    let values = resolve_in_tx(tx.as_mut(), org, &[key], None, Timestamp::now_utc()).await?;
    values
        .get(&key)
        .and_then(|value| value.as_ref().ok())
        .and_then(|value| value.value.as_int())
        .and_then(|value| usize::try_from(value).ok())
        .ok_or_else(|| KernelError::internal("privacy request detail limit unavailable").into())
}
