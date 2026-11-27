// SPDX-License-Identifier: LicenseRef-Proprietary
//! Overtime recognition work-rule attestations (`overtime_rule_attestations`)
//! and date-aware evaluation (`recorded` through `confirmed_on`, `approval` starting the day after).

use crate::PgSettingsError;
use crate::read::{db_error, load_rows_in_tx};
use crate::tx::require_live_scope;
use console_kernel_core::{
    AuditAction, AuditEvent, AuditRequestContext, KernelError, OrgId, Timestamp, TraceContext,
    UserId,
};
use console_platform_db::settings_read::resolve_loaded;
use console_platform_db::{DbError, with_audits, with_org_conn};
use console_settings_domain::{SettingKey, SettingValue};
use serde::Serialize;
use sqlx::{PgConnection, PgPool, Row};
use time::Date;
use uuid::Uuid;

pub const OVERTIME_ATTESTATION_AUDIT_ACTION: &str = "settings.overtime_attestation_record";

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct OvertimeRuleAttestation {
    pub id: Uuid,
    pub scope_entity_id: Option<Uuid>,
    pub confirmed_on: String,
    pub rule_reference: String,
    pub worker_notice_method: String,
    pub statutory_basis: String,
    pub recorded_by: Uuid,
    pub recorded_by_name: Option<String>,
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: Timestamp,
}

#[derive(Debug, Clone)]
pub struct NewOvertimeAttestation {
    pub scope_entity_id: Option<Uuid>,
    pub confirmed_on: Date,
    pub rule_reference: String,
    pub worker_notice_method: String,
    pub statutory_basis: Option<String>,
}

pub async fn list_attestations(
    pool: &PgPool,
    org: OrgId,
    scope_entity_id: Option<Uuid>,
) -> Result<Vec<OvertimeRuleAttestation>, PgSettingsError> {
    with_org_conn(pool, org, move |tx| {
        Box::pin(async move {
            let chain_ids: Vec<Uuid> = if let Some(target) = scope_entity_id {
                sqlx::query_scalar("SELECT scope_id FROM setting_scope_chain($1, $2) ORDER BY seq")
                    .bind(org.as_uuid())
                    .bind(target)
                    .fetch_all(tx.as_mut())
                    .await
                    .map_err(DbError::Sqlx)?
            } else {
                Vec::new()
            };
            let rows = sqlx::query(
                "SELECT a.id, a.scope_entity_id, a.confirmed_on, a.rule_reference,
                        a.worker_notice_method, a.statutory_basis, a.recorded_by, a.created_at,
                        u.display_name AS recorded_by_name
                   FROM overtime_rule_attestations a
                   LEFT JOIN person_accounts_current u
                     ON u.org_id = a.org_id AND u.id = a.recorded_by
                  WHERE a.org_id = $1
                    AND ($2::uuid IS NULL
                         OR a.scope_entity_id IS NULL
                         OR a.scope_entity_id = ANY($3))
                  ORDER BY a.confirmed_on DESC, a.created_at DESC",
            )
            .bind(org.as_uuid())
            .bind(scope_entity_id)
            .bind(&chain_ids)
            .fetch_all(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            rows.into_iter()
                .map(map_row)
                .collect::<Result<Vec<_>, _>>()
                .map_err(DbError::Sqlx)
                .map_err(PgSettingsError::Db)
        })
    })
    .await
}

pub async fn record_attestation(
    pool: &PgPool,
    org: OrgId,
    actor: UserId,
    cmd: NewOvertimeAttestation,
    (trace, request): (TraceContext, AuditRequestContext),
) -> Result<OvertimeRuleAttestation, PgSettingsError> {
    let rule_ref = cmd.rule_reference.trim().to_owned();
    let notice = cmd.worker_notice_method.trim().to_owned();
    let basis = cmd
        .statutory_basis
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Labor Standards Act Articles 50 and 53")
        .to_owned();
    if rule_ref.is_empty() || rule_ref.chars().count() > 300 {
        return Err(KernelError::validation("work rules reference is required")
            .with_code("overtime_rule_reference_invalid")
            .with_field("rule_reference")
            .into());
    }
    if notice.is_empty() || notice.chars().count() > 300 {
        return Err(KernelError::validation("worker notice method is required")
            .with_code("overtime_notice_method_invalid")
            .with_field("worker_notice_method")
            .into());
    }
    if basis.chars().count() > 300 {
        return Err(
            KernelError::validation("statutory basis exceeds 300 characters")
                .with_code("overtime_statutory_basis_invalid")
                .with_field("statutory_basis")
                .into(),
        );
    }

    with_audits(pool, org, move |tx| {
        Box::pin(async move {
            require_live_scope(tx.as_mut(), org, cmd.scope_entity_id).await?;
            if let Some(scope_id) = cmd.scope_entity_id {
                let layer: Option<String> = sqlx::query_scalar(
                    "SELECT layer FROM setting_scope_chain($1, $2) ORDER BY seq LIMIT 1",
                )
                .bind(org.as_uuid())
                .bind(scope_id)
                .fetch_optional(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                if layer.as_deref() == Some("person") {
                    return Err(PgSettingsError::Domain(
                        KernelError::validation(
                            "overtime work-rule attestations apply to organization scopes, not individuals",
                        )
                        .with_code("setting_scope_not_allowed")
                        .with_field("scope_entity_id"),
                    ));
                }
            }
            let row = sqlx::query(
                "INSERT INTO overtime_rule_attestations
                     (org_id, scope_entity_id, confirmed_on, rule_reference,
                      worker_notice_method, statutory_basis, recorded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id, scope_entity_id, confirmed_on, rule_reference,
                           worker_notice_method, statutory_basis, recorded_by, created_at,
                           (SELECT display_name FROM person_accounts_current
                             WHERE org_id = $1 AND id = $7) AS recorded_by_name",
            )
            .bind(org.as_uuid())
            .bind(cmd.scope_entity_id)
            .bind(cmd.confirmed_on)
            .bind(&rule_ref)
            .bind(&notice)
            .bind(&basis)
            .bind(actor.as_uuid())
            .fetch_one(tx.as_mut())
            .await
            .map_err(DbError::Sqlx)?;
            let out = map_row(row).map_err(DbError::Sqlx)?;
            let after =
                serde_json::to_value(&out).map_err(|e| KernelError::internal(e.to_string()))?;
            let event = AuditEvent::new(
                Some(actor),
                AuditAction::new(OVERTIME_ATTESTATION_AUDIT_ACTION)?,
                "overtime_rule_attestation",
                out.id.to_string(),
                trace,
                out.created_at,
            )
            .with_org(org)
            .with_request_context(request)
            .with_snapshots(None, Some(after));
            Ok((out, vec![event]))
        })
    })
    .await
}

/// Evaluates the effective overtime recognition basis on `work_date` for `entity`:
/// if the resolved setting is `"recorded"`, returns `"recorded"`; if `"approval"`,
/// checks the nearest attestation in the scope chain (or tenant root): dates on or
/// before `confirmed_on` (or with no attestation yet) evaluate as `"recorded"`,
/// switching to `"approval"` starting the day after `confirmed_on`.
pub async fn resolve_overtime_recognition_on_date_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    entity: Option<Uuid>,
    work_date: Date,
    as_of: Timestamp,
) -> Result<&'static str, KernelError> {
    let key = SettingKey::AttendanceOvertimeRecognition;
    let (chain, rows_map) = load_rows_in_tx(&mut *conn, org, &[key], entity).await?;
    let rows = rows_map.get(&key).map_or(&[][..], Vec::as_slice);
    let resolved = resolve_loaded(key, rows, &chain, as_of)
        .map_err(|e| KernelError::internal(e.to_string()))?;
    if resolved.value == SettingValue::Code("recorded") {
        return Ok("recorded");
    }
    let chain_ids: Vec<Uuid> = chain.iter().map(|s| s.id).collect();
    let confirmed_on: Option<Date> = sqlx::query_scalar(
        "SELECT confirmed_on
           FROM overtime_rule_attestations
          WHERE org_id = $1
            AND (scope_entity_id IS NULL OR scope_entity_id = ANY($2))
          ORDER BY array_position($2::uuid[], scope_entity_id) NULLS LAST,
                   confirmed_on DESC, created_at DESC
          LIMIT 1",
    )
    .bind(org.as_uuid())
    .bind(&chain_ids)
    .fetch_optional(&mut *conn)
    .await
    .map_err(db_error)?;

    match confirmed_on {
        Some(confirmed) if work_date > confirmed => Ok("approval"),
        _ => Ok("recorded"),
    }
}

fn map_row(row: sqlx::postgres::PgRow) -> Result<OvertimeRuleAttestation, sqlx::Error> {
    let confirmed_on: Date = row.try_get("confirmed_on")?;
    Ok(OvertimeRuleAttestation {
        id: row.try_get("id")?,
        scope_entity_id: row.try_get("scope_entity_id")?,
        confirmed_on: confirmed_on.to_string(),
        rule_reference: row.try_get("rule_reference")?,
        worker_notice_method: row.try_get("worker_notice_method")?,
        statutory_basis: row.try_get("statutory_basis")?,
        recorded_by: row.try_get("recorded_by")?,
        recorded_by_name: row.try_get("recorded_by_name")?,
        created_at: row.try_get("created_at")?,
    })
}
