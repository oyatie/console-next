use crate::*;

/// The org-local business date (KST) used for effective-date gating.
pub(crate) fn today_kst() -> Date {
    OffsetDateTime::now_utc().to_offset(offset!(+9)).date()
}

pub(crate) fn bounded_text(value: &str, name: &str, max: usize) -> Result<(), KernelError> {
    if value.trim().is_empty() || value.chars().count() > max {
        return Err(KernelError::validation(format!(
            "{name} is required and must be at most {max} characters"
        )));
    }
    Ok(())
}

pub(crate) fn audit(
    org: OrgId,
    actor: UserId,
    action: &str,
    target_kind: &str,
    target_id: String,
    at: OffsetDateTime,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        Some(actor),
        AuditAction::new(action)?,
        target_kind,
        target_id,
        TraceContext::generate(),
        at,
    )
    .with_org(org))
}

pub(crate) fn fingerprint(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.to_string());
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
