//! Reason-code catalog (BW-07) on Postgres: the in-transaction validation
//! every reason-bearing use case calls, the catalog read, and the admin writes. Tenant codes live in `reason_codes` (RLS); system
//! codes are the code roster, never rows.

use crate::read::db_error;
use crate::reason_tx::{PgReasonTx, view};
use crate::{PgSettingsError, PgSettingsStore};
use console_kernel_core::{AuditRequestContext, KernelError, OrgId, TraceContext};
use console_platform_db::{DbError, with_audits, with_org_conn};
use console_settings_application::Actor;
use console_settings_application::reason_codes::{
    AddReasonCode, TenantCodeView, UpdateReasonCode, add_reason_code, update_reason_code,
};
use console_settings_domain::code_lists::{
    OTHER, ReasonDomain, SystemCode, TenantCode, ValidReason, is_tenant_code, validate_reason,
};
use serde::Serialize;
use sqlx::{PgConnection, Row};

/// Checks a command's reason inside the caller's armed transaction: the code
/// must be a system code of `domain` or an active tenant code of it, and a
/// code that requires a note must have one. Call it before writing the
/// `reason_code` / note columns (BW-07 column contract in the migration).
///
/// like `load_rows_in_tx`, ADR-006 would place this in
/// `platform/db` so other adapters need no edge to this crate; that path is
/// outside the F-SET lane. Self-contained so the move is verbatim.
///
/// # Errors
/// A coded `ReasonError` as a 422 `KernelError`; internal on a query failure.
pub async fn validate_reason_in_tx(
    conn: &mut PgConnection,
    org: OrgId,
    domain: ReasonDomain,
    code: &str,
    note: Option<&str>,
) -> Result<ValidReason, KernelError> {
    let mut tenant = Vec::new();
    if is_tenant_code(code) {
        let row = sqlx::query(
            "SELECT requires_note, active, involuntary, notice_required FROM reason_codes
              WHERE org_id = $1 AND domain = $2 AND code = $3",
        )
        .bind(org.as_uuid())
        .bind(domain.as_str())
        .bind(code)
        .fetch_optional(conn)
        .await
        .map_err(db_error)?;
        if let Some(row) = row {
            tenant.push(TenantCode {
                code: code.to_owned(),
                requires_note: row.try_get("requires_note").map_err(db_error)?,
                active: row.try_get("active").map_err(db_error)?,
                involuntary: row.try_get("involuntary").map_err(db_error)?,
                notice_required: row.try_get("notice_required").map_err(db_error)?,
            });
        }
    }
    Ok(validate_reason(domain, code, note, &tenant)?)
}

/// One code of a domain's catalog. System codes carry no label (the frontend
/// catalog renders `reason.<domain>.<code>`); tenant codes carry the admin's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CatalogEntry {
    pub code: String,
    pub system: bool,
    pub requires_note: bool,
    pub involuntary: bool,
    pub notice_required: bool,
    pub active: bool,
    pub label_ko: Option<String>,
    pub label_en: Option<String>,
}

impl PgSettingsStore {
    /// `domain`'s catalog: system codes in roster order with `OTHER` last,
    /// the tenant's codes (active and inactive) by `sort` before it.
    ///
    /// # Errors
    /// Internal on a query failure.
    pub async fn reason_catalog(
        &self,
        org: OrgId,
        domain: ReasonDomain,
    ) -> Result<Vec<CatalogEntry>, PgSettingsError> {
        let tenant = with_org_conn(&self.pool, org, move |tx| {
            Box::pin(async move {
                let rows = sqlx::query(
                    "SELECT domain, code, label_ko, label_en, requires_note, active, sort,
                            involuntary, notice_required
                       FROM reason_codes
                      WHERE org_id = $1 AND domain = $2
                      ORDER BY sort, created_at",
                )
                .bind(org.as_uuid())
                .bind(domain.as_str())
                .fetch_all(tx.as_mut())
                .await
                .map_err(DbError::Sqlx)?;
                rows.iter()
                    .map(view)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(PgSettingsError::Domain)
            })
        })
        .await?;
        let system = |c: &SystemCode| CatalogEntry {
            code: c.code.to_owned(),
            system: true,
            requires_note: c.requires_note,
            involuntary: c.involuntary,
            notice_required: c.notice_required,
            active: true,
            label_ko: None,
            label_en: None,
        };
        let codes = domain.system_codes();
        let mut out: Vec<CatalogEntry> = codes
            .iter()
            .filter(|c| c.code != OTHER.code)
            .map(system)
            .collect();
        out.extend(tenant.into_iter().map(|t| CatalogEntry {
            code: t.code,
            system: false,
            requires_note: t.requires_note,
            involuntary: t.involuntary,
            notice_required: t.notice_required,
            active: t.active,
            label_ko: Some(t.label_ko),
            label_en: t.label_en,
        }));
        out.extend(codes.iter().filter(|c| c.code == OTHER.code).map(system));
        Ok(out)
    }

    /// Adds a tenant code in one audited transaction.
    ///
    /// # Errors
    /// See [`add_reason_code`]; database failures as [`PgSettingsError::Db`].
    pub async fn add_reason_code<A>(
        &self,
        actor: Actor,
        cmd: AddReasonCode,
        audit: (TraceContext, AuditRequestContext),
        authorize: A,
    ) -> Result<TenantCodeView, PgSettingsError>
    where
        A: FnOnce(ReasonDomain) -> Result<(), KernelError> + Send + 'static,
    {
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let mut port = PgReasonTx { tx, org: actor.org };
                add_reason_code(&mut port, authorize, actor, cmd, audit)
                    .await
                    .map_err(PgSettingsError::Domain)
            })
        })
        .await
    }

    /// Switches a tenant code on/off or reorders it in one audited
    /// transaction.
    ///
    /// # Errors
    /// See [`update_reason_code`]; database failures as [`PgSettingsError::Db`].
    pub async fn update_reason_code<A>(
        &self,
        actor: Actor,
        cmd: UpdateReasonCode,
        audit: (TraceContext, AuditRequestContext),
        authorize: A,
    ) -> Result<TenantCodeView, PgSettingsError>
    where
        A: FnOnce(ReasonDomain) -> Result<(), KernelError> + Send + 'static,
    {
        with_audits(&self.pool, actor.org, move |tx| {
            Box::pin(async move {
                let mut port = PgReasonTx { tx, org: actor.org };
                update_reason_code(&mut port, authorize, actor, cmd, audit)
                    .await
                    .map_err(PgSettingsError::Domain)
            })
        })
        .await
    }
}
