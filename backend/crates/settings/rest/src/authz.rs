// SPDX-License-Identifier: LicenseRef-Proprietary
//! Cedar-backed authorization for the settings registry and reason-code catalog (AD-F17).
//!
//! Evaluates `settings_manage` and `reason_code_manage` through Cedar PBAC.
//! Supports:
//! - Tenant ops authority comes from Cedar principal policy, independently of grants
//! - Custom scope grants (`NodeKind::Tenant` for 전체, or 법인 or 사업장 for scoped writes)
//! - Scoped grants writing tenant-wide return 403 `scope_tenant_wide_only`
//! - Scoped grants writing outside their scope return 403 `out_of_scope`
//! - Loosening without step-up returns 403 `step_up_required`
//! - Closed reason domains return 403 `reason_domain_closed`
//! - Enforces Cedar PBAC via `enforce_action`

use console_kernel_core::KernelError;
use console_platform_authz::access::NodeKind;
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::cedar_pbac::facts::scope::{granted_scope, scope_facts};
use console_platform_authz::{
    Action, AuthorizationResource, Feature, Principal, authorize_org_wide,
};
use console_settings_application::ChangeFacts;
use console_settings_domain::Direction;
use console_settings_domain::code_lists::ReasonDomain;

/// Build scope facts from the shared principal loader; Cedar alone decides reach.
fn authorize_settings(
    principal: &Principal,
    direction: Direction,
    step_up: bool,
    resource_entities: &[uuid::Uuid],
) -> Result<(), KernelError> {
    let granted = if principal.is_tenant_ops {
        None
    } else {
        granted_scope(
            principal
                .scopes_for(Feature::SettingsManage)
                .map(|g| (g.kind, g.id)),
        )
    };
    let facts = Facts::new()
        .bool(
            "actor_holds_permission",
            granted.as_ref().is_none_or(|ids| !ids.is_empty()),
        )
        .string(
            "direction",
            match direction {
                Direction::Tighten => "tighten",
                Direction::Loosen => "loosen",
                Direction::Neutral => "neutral",
            },
        )
        .bool("step_up", step_up);
    enforce_action(
        principal,
        Feature::SettingsManage,
        AuthorizationResource::org_wide(principal.org_id, "setting"),
        &scope_facts(facts, granted.as_deref(), resource_entities),
    )
}

/// Authority at the requested scope, independently of registry order or step-up freshness.
pub fn can_change(principal: &Principal, resource_entities: &[uuid::Uuid]) -> bool {
    authorize_settings(principal, Direction::Neutral, true, resource_entities).is_ok()
}

/// Authorizes a setting change through Cedar `settings_manage`.
pub fn authorize_change(principal: &Principal, facts: &ChangeFacts) -> Result<(), KernelError> {
    authorize_settings(
        principal,
        facts.direction,
        facts.step_up,
        &facts.resource_entities,
    )
}

/// Checks whether `principal` holds authority over reason-code catalog.
pub fn holds_reason_code_manage(principal: &Principal) -> Result<(), KernelError> {
    let tenant_wide = authorize_org_wide(principal, Action::new(Feature::ReasonCodeManage)).is_ok()
        || principal
            .scopes_for(Feature::ReasonCodeManage)
            .any(|g| g.kind == NodeKind::Tenant);

    if tenant_wide {
        Ok(())
    } else if principal
        .scopes_for(Feature::ReasonCodeManage)
        .any(|g| g.kind == NodeKind::LegalEntity)
    {
        Err(
            KernelError::forbidden("this works on the whole tenant; a grant over 전체 is needed")
                .with_code("scope_tenant_wide_only"),
        )
    } else {
        Err(KernelError::forbidden("reason_code_manage is not allowed"))
    }
}

/// Authorizes reason-code management through Cedar `reason_code_manage`.
pub fn authorize_manage(
    principal: &Principal,
    domain: Option<ReasonDomain>,
) -> Result<(), KernelError> {
    let Some(domain) = domain else {
        return Err(KernelError::forbidden("reason code stats are not enabled"));
    };

    let holds_res = holds_reason_code_manage(principal);
    match &holds_res {
        Err(err) if !principal.is_tenant_ops && err.code == Some("scope_tenant_wide_only") => {
            return holds_res;
        }
        _ => {}
    }
    let holds = holds_res.is_ok();

    if !domain.tenant_extensible() {
        return Err(KernelError::forbidden(
            "governance reason domains are closed to tenant customization",
        )
        .with_code("reason_domain_closed")
        .with_field("domain"));
    }

    let cedar_facts = Facts::new()
        .bool("actor_holds_permission", holds)
        .bool("domain_tenant_extensible", domain.tenant_extensible());
    let resource = AuthorizationResource::org_wide(principal.org_id, "reason_code");
    enforce_action(principal, Feature::ReasonCodeManage, resource, &cedar_facts)
}
