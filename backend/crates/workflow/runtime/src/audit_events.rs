use super::*;

pub(crate) fn run_audit_event(
    action: &str,
    audit: &AuditContext,
    run_id: Uuid,
    org: OrgId,
    before: Option<Value>,
    after: Option<Value>,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        audit.actor,
        AuditAction::new(action)?,
        "workflow_run",
        run_id.to_string(),
        audit.trace.clone(),
        audit.occurred_at,
    )
    .with_org(org)
    .with_snapshots(before, after))
}

pub(super) fn node_audit_event(
    action: &str,
    audit: &AuditContext,
    node_run_id: Uuid,
    org: OrgId,
    final_status: NodeStatus,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        audit.actor,
        AuditAction::new(action)?,
        "workflow_node_run",
        node_run_id.to_string(),
        audit.trace.clone(),
        audit.occurred_at,
    )
    .with_org(org)
    .with_snapshots(
        Some(json!({ "status": NodeStatus::Pending.as_db_str() })),
        Some(json!({ "status": final_status.as_db_str() })),
    ))
}

pub(super) fn guardrail_audit_event(
    action: &str,
    audit: &AuditContext,
    node_run_id: Uuid,
    org: OrgId,
    final_status: NodeStatus,
    selected_port: Option<&str>,
) -> Result<AuditEvent, KernelError> {
    Ok(AuditEvent::new(
        audit.actor,
        AuditAction::new(action)?,
        "workflow_guardrail",
        node_run_id.to_string(),
        audit.trace.clone(),
        audit.occurred_at,
    )
    .with_org(org)
    .with_snapshots(
        None,
        Some(json!({
            "node_run_id": node_run_id,
            "status": final_status.as_db_str(),
            "selected_port": selected_port,
        })),
    ))
}
