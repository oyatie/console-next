// SPDX-License-Identifier: LicenseRef-Proprietary
//! Cedar-backed authorization for the settings registry and reason-code catalog (AD-F17).
//!
//! Evaluates `settings_manage` and `reason_code_manage` through Cedar PBAC.
//! Supports:
//! - Tenant ops authority comes from Cedar principal policy, independently of grants
//! - Custom scope grants (`NodeKind::Tenant` for 전체, or `NodeKind::LegalEntity` for scoped writes)
//! - Scoped grants writing tenant-wide return 403 `scope_tenant_wide_only`
//! - Scoped grants writing outside their scope return 403 `out_of_scope`
//! - Loosening without step-up returns 403 `step_up_required`
//! - Closed reason domains return 403 `reason_domain_closed`
//! - Enforces Cedar PBAC via `enforce_action`

use console_kernel_core::KernelError;
use console_platform_authz::access::NodeKind;
use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{
    Action, AuthorizationResource, Feature, Principal, authorize_org_wide,
};
use console_settings_application::ChangeFacts;
use console_settings_domain::Direction;
use console_settings_domain::code_lists::ReasonDomain;
use uuid::Uuid;

/// Checks whether `principal` holds authority over settings at `target_scope`.
///
/// Returns `Ok(())` if authorized.
/// Returns `Err` with a specific code (`scope_tenant_wide_only` or `out_of_scope`) if the account
/// holds grants but they do not cover `target_scope`.
/// Returns `Err` with a generic forbidden if no grant is held.
pub fn holds_settings_manage(
    principal: &Principal,
    target_scope: Option<Uuid>,
) -> Result<(), KernelError> {
    let tenant_wide = authorize_org_wide(principal, Action::new(Feature::SettingsManage)).is_ok()
        || principal
            .scopes_for(Feature::SettingsManage)
            .any(|g| g.kind == NodeKind::Tenant);

    match target_scope {
        None => {
            if tenant_wide {
                Ok(())
            } else if principal
                .scopes_for(Feature::SettingsManage)
                .any(|g| g.kind == NodeKind::LegalEntity)
            {
                Err(KernelError::forbidden(
                    "this works on the whole tenant; a grant over 전체 is needed",
                )
                .with_code("scope_tenant_wide_only"))
            } else {
                Err(KernelError::forbidden("settings_manage is not allowed"))
            }
        }
        Some(target_id) => {
            if tenant_wide
                || principal
                    .scopes_for(Feature::SettingsManage)
                    .any(|g| g.kind == NodeKind::LegalEntity && g.id == target_id)
            {
                Ok(())
            } else if principal
                .scopes_for(Feature::SettingsManage)
                .any(|g| g.kind == NodeKind::LegalEntity)
            {
                Err(
                    KernelError::forbidden("this is outside the scope this account holds")
                        .with_code("out_of_scope"),
                )
            } else {
                Err(KernelError::forbidden("settings_manage is not allowed"))
            }
        }
    }
}

/// Authorizes a setting change through Cedar `settings_manage`.
pub fn authorize_change(principal: &Principal, facts: &ChangeFacts) -> Result<(), KernelError> {
    let holds_res = holds_settings_manage(principal, facts.scope_entity_id);
    match &holds_res {
        Err(err)
            if !principal.is_tenant_ops
                && (err.code == Some("scope_tenant_wide_only")
                    || err.code == Some("out_of_scope")) =>
        {
            return holds_res;
        }
        _ => {}
    }
    let holds = holds_res.is_ok();

    if (holds || principal.is_tenant_ops) && facts.direction == Direction::Loosen && !facts.step_up
    {
        return Err(
            KernelError::forbidden("loosening a setting requires passkey step-up")
                .with_code("step_up_required"),
        );
    }

    let direction = match facts.direction {
        Direction::Tighten => "tighten",
        Direction::Loosen => "loosen",
        Direction::Neutral => "neutral",
    };
    let cedar_facts = Facts::new()
        .bool("actor_holds_permission", holds)
        .string("direction", direction)
        .bool("step_up", facts.step_up);
    let resource = AuthorizationResource::org_wide(principal.org_id, "setting");
    enforce_action(principal, Feature::SettingsManage, resource, &cedar_facts)
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
