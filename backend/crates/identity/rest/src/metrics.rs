use crate::error::RestError;
use axum::http::StatusCode;
use console_kernel_core::BranchScope;
use console_platform_authz::Principal;

pub(crate) const POLICY_STUDIO_OPERATION_TOTAL: &str = "policy_studio_operation_total";
pub(crate) fn record_policy_studio_operation(operation: &'static str, outcome: &'static str) {
    metrics::counter!(
        POLICY_STUDIO_OPERATION_TOTAL,
        "operation" => operation,
        "outcome" => outcome,
    )
    .increment(1);
}

pub(crate) fn policy_branch_scope_label(scope: &BranchScope) -> &'static str {
    match scope {
        BranchScope::All => "all",
        BranchScope::Branches(branches) if branches.is_empty() => "none",
        BranchScope::Branches(_) => "branches",
    }
}

pub(crate) fn record_policy_studio_rejection(
    operation: &'static str,
    principal: &Principal,
    error: &RestError,
) {
    let outcome = if error.status == StatusCode::FORBIDDEN {
        "denied"
    } else {
        "invalid"
    };
    record_policy_studio_operation(operation, outcome);
    tracing::warn!(
        event = "policy_studio_operation_rejected",
        operation,
        outcome,
        error_code = error.code,
        actor_user_id = %principal.user_id,
        branch_scope = policy_branch_scope_label(&principal.branch_scope),
        "policy studio operation rejected"
    );
}
