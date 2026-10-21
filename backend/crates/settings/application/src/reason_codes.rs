//! Reason-code catalog admin use cases (BW-07): a tenant adds its own code
//! inline (no deploy) or switches one on/off and reorders it. Each runs the
//! pure check, lets the caller's authorizer decide who may (Cedar
//! `reason_code_manage`), writes, and returns the audit event. Validating a
//! command's reason is not a use case of its own: it is a read the owning
//! use case makes (`validate_reason_in_tx` on the adapter).

use crate::Actor;
use console_kernel_core::{
    AuditAction, AuditEvent, AuditRequestContext, KernelError, TraceContext,
};
use console_settings_domain::code_lists::{
    NewTenantCode, ReasonDomain, check_new_tenant_code, check_toggle, parse_domain,
};
use serde::Serialize;
use std::future::Future;
use uuid::Uuid;

pub const REASON_CODE_ADD_AUDIT_ACTION: &str = "reason_codes.add";
pub const REASON_CODE_UPDATE_AUDIT_ACTION: &str = "reason_codes.update";

/// One stored tenant code, as the catalog and the audit row show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TenantCodeView {
    pub domain: ReasonDomain,
    pub code: String,
    pub label_ko: String,
    pub label_en: Option<String>,
    pub requires_note: bool,
    pub active: bool,
    pub sort: i32,
}

/// The output port, implemented once on the adapter's transaction wrapper.
pub trait ReasonCodeStore {
    fn now(
        &mut self,
    ) -> impl Future<Output = Result<console_kernel_core::Timestamp, KernelError>> + Send;

    /// Inserts the code. A label already used in the domain is a coded
    /// conflict (`reason_label_taken`).
    fn insert(
        &mut self,
        code: &NewTenantCode,
        sort: i32,
        by: Actor,
    ) -> impl Future<Output = Result<TenantCodeView, KernelError>> + Send;

    /// Applies `active` / `sort` to the tenant's code; `None` when the tenant
    /// has no such code. Returns the row before and after.
    fn update(
        &mut self,
        domain: ReasonDomain,
        code: &str,
        active: Option<bool>,
        sort: Option<i32>,
    ) -> impl Future<Output = Result<Option<(TenantCodeView, TenantCodeView)>, KernelError>> + Send;
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AddReasonCode {
    pub domain: String,
    pub label_ko: String,
    pub label_en: Option<String>,
    pub requires_note: bool,
    pub sort: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateReasonCode {
    pub domain: String,
    pub code: String,
    pub active: Option<bool>,
    pub sort: Option<i32>,
}

/// Adds a tenant code: check, authorize, insert, audit.
///
/// # Errors
/// A coded `ReasonError` (422); whatever `authorize` refuses with (fail
/// closed); `reason_label_taken` (409); store errors as they come.
pub async fn add_reason_code<S, A>(
    store: &mut S,
    authorize: A,
    actor: Actor,
    cmd: AddReasonCode,
    (trace, request): (TraceContext, AuditRequestContext),
) -> Result<(TenantCodeView, Vec<AuditEvent>), KernelError>
where
    S: ReasonCodeStore + Send,
    A: FnOnce(ReasonDomain) -> Result<(), KernelError> + Send,
{
    let domain = parse_domain(&cmd.domain)?;
    let new = check_new_tenant_code(
        domain,
        Uuid::new_v4(),
        &cmd.label_ko,
        cmd.label_en.as_deref(),
        cmd.requires_note,
    )?;
    authorize(domain)?;
    let now = store.now().await?;
    let view = store.insert(&new, cmd.sort.unwrap_or(0), actor).await?;
    let event = audit_event(
        REASON_CODE_ADD_AUDIT_ACTION,
        actor,
        &view,
        None,
        (trace, request),
        now,
    )?;
    Ok((view, vec![event]))
}

/// Switches a tenant code on/off or reorders it: check, authorize, update,
/// audit. System codes are fixed.
///
/// # Errors
/// - `reason_code_update_empty` (422) when neither field is given;
/// - a coded `ReasonError` (422), `reason_code_system` for a system code;
/// - whatever `authorize` refuses with (fail closed);
/// - `reason_code_not_found` (404) when the tenant has no such code.
pub async fn update_reason_code<S, A>(
    store: &mut S,
    authorize: A,
    actor: Actor,
    cmd: UpdateReasonCode,
    (trace, request): (TraceContext, AuditRequestContext),
) -> Result<(TenantCodeView, Vec<AuditEvent>), KernelError>
where
    S: ReasonCodeStore + Send,
    A: FnOnce(ReasonDomain) -> Result<(), KernelError> + Send,
{
    let domain = parse_domain(&cmd.domain)?;
    if cmd.active.is_none() && cmd.sort.is_none() {
        return Err(
            KernelError::validation("nothing to change: give active or sort")
                .with_code("reason_code_update_empty")
                .with_field("active"),
        );
    }
    check_toggle(domain, &cmd.code)?;
    authorize(domain)?;
    let now = store.now().await?;
    let (before, after) = store
        .update(domain, &cmd.code, cmd.active, cmd.sort)
        .await?
        .ok_or_else(|| not_found(domain, &cmd.code))?;
    let event = audit_event(
        REASON_CODE_UPDATE_AUDIT_ACTION,
        actor,
        &after,
        Some(&before),
        (trace, request),
        now,
    )?;
    Ok((after, vec![event]))
}

fn not_found(domain: ReasonDomain, code: &str) -> KernelError {
    KernelError::not_found(format!(
        "no tenant reason code {code} in {}",
        domain.as_str()
    ))
    .with_code("reason_code_not_found")
    .with_field("reason_code")
}

fn audit_event(
    action: &str,
    actor: Actor,
    after: &TenantCodeView,
    before: Option<&TenantCodeView>,
    (trace, request): (TraceContext, AuditRequestContext),
    now: console_kernel_core::Timestamp,
) -> Result<AuditEvent, KernelError> {
    let json = |v: &TenantCodeView| {
        serde_json::to_value(v).map_err(|e| KernelError::internal(e.to_string()))
    };
    Ok(AuditEvent::new(
        Some(actor.user),
        AuditAction::new(action)?,
        "reason_code",
        format!("{}/{}", after.domain.as_str(), after.code),
        trace,
        now,
    )
    .with_org(actor.org)
    .with_request_context(request)
    .with_snapshots(before.map(json).transpose()?, Some(json(after)?)))
}
