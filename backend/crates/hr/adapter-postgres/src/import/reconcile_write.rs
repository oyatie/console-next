//! 이관 확인 writes: one row's verification state (versioned) and the run's
//! one HR sign-off. Both lock the run row first, so a sign-off and a late
//! row write never interleave; a signed-off run is frozen. No second person
//! (#26): the sign-off records who attested and over which open count.

use console_hr_domain::text::normalize_optional_limited_text;
use console_kernel_core::{AuditAction, AuditEvent, KernelError, OrgId, TraceContext, UserId};
use console_platform_authz::{Feature, Principal};
use console_platform_db::with_audits;
use http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};
use time::OffsetDateTime;
use uuid::Uuid;

use super::reconcile::{ImportSignoff, ReconcileCounts, applied_run, counts, plan_cte, signoff};
use super::reconcile_rows::{ReconcileRow, RowFilter, load_rows};
use crate::authz::authorize_hr_org_wide;
use crate::{HrError, HrService};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SetReconcileCheckRequest {
    /// CONFIRMED (확인함) or NEEDS_CHECK (확인 필요).
    #[serde(deserialize_with = "deserialize_enum_15")]
    pub state: String,
    #[serde(default)]
    pub note: Option<String>,
    /// The row's `version` as read (0 = never set); a different one is 409.
    #[serde(default)]
    pub expected_version: Option<i32>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignOffImportRequest {
    /// The open count (확인 필요 + 미확인) the person saw.
    pub expected_open_count: i64,
    /// Required when the open count is not 0: signing over open rows is said.
    #[serde(default)]
    pub acknowledge_open: bool,
    #[serde(default)]
    pub note: Option<String>,
}

fn error(
    status: StatusCode,
    code: &'static str,
    message: &str,
    refusals: Option<Value>,
) -> HrError {
    HrError {
        errors: None,
        status,
        code,
        message: message.to_owned(),
        refusals: refusals.map(Box::new),
    }
}

fn audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    run_id: Uuid,
    snapshot: Value,
) -> Result<AuditEvent, HrError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action).map_err(HrError::from_kernel)?,
        "data_import_run",
        run_id.to_string(),
        TraceContext::generate(),
        OffsetDateTime::now_utc(),
    )
    .with_source(console_kernel_core::AuditSource::Import)
    .with_org(org)
    .with_snapshots(None, Some(snapshot)))
}

/// 409 `import_signed_off` naming the sign-off, when there is one.
async fn refuse_if_signed(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    org: Uuid,
    run_id: Uuid,
) -> Result<(), HrError> {
    match signoff(tx, org, run_id).await? {
        Some(done) => Err(error(
            StatusCode::CONFLICT,
            "import_signed_off",
            "this import is signed off; its 이관 확인 is closed",
            Some(json!([done])),
        )),
        None => Ok(()),
    }
}

impl HrService {
    /// `PUT /api/v1/employees/import/{run_id}/reconcile/rows/{source_key}`.
    pub async fn set_import_reconcile_check(
        &self,
        principal: Principal,
        run_id: Uuid,
        source_key: String,
        body: SetReconcileCheckRequest,
    ) -> Result<ReconcileRow, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let state = match body.state.trim().to_ascii_uppercase().as_str() {
            "CONFIRMED" => "CONFIRMED",
            "NEEDS_CHECK" => "NEEDS_CHECK",
            _ => {
                return Err(HrError::validation(
                    "state must be CONFIRMED or NEEDS_CHECK",
                ));
            }
        };
        let note = normalize_optional_limited_text(body.note, 1000, "note")?;
        let (org, actor) = (principal.org_id, principal.user_id);
        let org_uuid = *org.as_uuid();
        let key = source_key;
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                applied_run(tx, org_uuid, run_id, true).await?;
                refuse_if_signed(tx, org_uuid, run_id).await?;
                let planned: bool = sqlx::query_scalar(concat!(
                    plan_cte!(),
                    "SELECT EXISTS (SELECT 1 FROM plan WHERE source_key = $3)"
                ))
                .bind(org_uuid)
                .bind(run_id)
                .bind(&key)
                .fetch_one(tx.as_mut())
                .await?;
                if !planned {
                    return Err(HrError::from_kernel(KernelError::not_found("import row not found")));
                }
                let current: i32 = sqlx::query_scalar(
                    "SELECT COALESCE((SELECT version FROM import_reconcile_checks \
                     WHERE org_id = $1 AND run_id = $2 AND source_key = $3 FOR UPDATE), 0)",
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(&key)
                .fetch_one(tx.as_mut())
                .await?;
                if body.expected_version.is_some_and(|v| v != current) {
                    return Err(error(
                        StatusCode::CONFLICT,
                        "stale_revision",
                        "the row was checked by someone else since you read it",
                        Some(json!([{"source_key": key, "current_version": current}])),
                    ));
                }
                let row = load_rows(tx, org_uuid, run_id, RowFilter { state: None, after: None, limit: 1, key: Some(&key) }).await?
                    .pop().ok_or_else(|| HrError::internal("import row vanished"))?;
                if state == "CONFIRMED" {
                    console_hr_domain::import::company_review::validate_confirmation(
                        row.company_confirmation.is_some(),
                        row.company_confirmation.as_ref().is_some_and(|c| c.confirmed_employer.is_some()),
                    ).map_err(crate::lifecycle::title_reason::coded)?;
                }
                sqlx::query(
                    "INSERT INTO import_reconcile_checks (org_id, run_id, source_key, state, note, checked_by) \
                     VALUES ($1, $2, $3, $4, $5, $6) \
                     ON CONFLICT (org_id, run_id, source_key) DO UPDATE SET state = EXCLUDED.state, \
                       note = EXCLUDED.note, checked_by = EXCLUDED.checked_by, checked_at = now(), \
                       version = import_reconcile_checks.version + 1",
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(&key)
                .bind(state)
                .bind(&note)
                .bind(*actor.as_uuid())
                .execute(tx.as_mut())
                .await?;
                let event = audit(org, actor, "data_import.reconcile_check", run_id,
                    json!({"run_id": run_id, "source_key": key, "state": state, "version": current + 1}))?;
                let filter = RowFilter { state: None, after: None, limit: 1, key: Some(&key) };
                let row = load_rows(tx, org_uuid, run_id, filter)
                    .await?
                    .pop()
                    .ok_or_else(|| HrError::internal("reconcile row vanished after its write"))?;
                Ok((row, vec![event]))
            })
        })
        .await
    }

    /// `POST /api/v1/employees/import/{run_id}/signoff`.
    pub async fn sign_off_import(
        &self,
        principal: Principal,
        run_id: Uuid,
        body: SignOffImportRequest,
    ) -> Result<ImportSignoff, HrError> {
        authorize_hr_org_wide(&principal, Feature::EmployeeDirectoryManage)?;
        let note = normalize_optional_limited_text(body.note, 1000, "note")?;
        let (org, actor) = (principal.org_id, principal.user_id);
        let org_uuid = *org.as_uuid();
        with_audits::<_, _, HrError>(&self.pool, org, move |tx| {
            Box::pin(async move {
                applied_run(tx, org_uuid, run_id, true).await?;
                refuse_if_signed(tx, org_uuid, run_id).await?;
                let now: ReconcileCounts = counts(tx, org_uuid, run_id).await?;
                if now.open() != body.expected_open_count {
                    return Err(error(
                        StatusCode::CONFLICT,
                        "import_reconcile_changed",
                        "the open count changed since you read it; reload 이관 확인",
                        Some(json!([now])),
                    ));
                }
                if now.open() > 0 && !body.acknowledge_open {
                    return Err(error(
                        StatusCode::PRECONDITION_REQUIRED,
                        "import_signoff_ack_required",
                        "rows are still open; sign off over them only by saying so",
                        Some(json!([now])),
                    ));
                }
                let narrow = |n: i64| i32::try_from(n).map_err(|_| HrError::internal("count overflow"));
                sqlx::query(
                    "INSERT INTO import_signoffs (org_id, run_id, signed_by, total_rows, confirmed, \
                     needs_check, unchecked, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                )
                .bind(org_uuid)
                .bind(run_id)
                .bind(*actor.as_uuid())
                .bind(narrow(now.rows)?)
                .bind(narrow(now.confirmed)?)
                .bind(narrow(now.needs_check)?)
                .bind(narrow(now.unchecked)?)
                .bind(&note)
                .execute(tx.as_mut())
                .await?;
                let done = signoff(tx, org_uuid, run_id)
                    .await?
                    .ok_or_else(|| HrError::internal("sign-off vanished after its write"))?;
                let event = audit(org, actor, "data_import.signoff", run_id,
                    json!({"run_id": run_id, "counts": now, "acknowledged_open": now.open() > 0}))?;
                Ok((done, vec![event]))
            })
        })
        .await
    }
}

fn deserialize_enum_15<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    console_kernel_core::validation::deserialize_enum_string(
        deserializer,
        &["CONFIRMED", "NEEDS_CHECK"],
    )
}
