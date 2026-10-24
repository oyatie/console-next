// SPDX-License-Identifier: LicenseRef-Proprietary
//! Tenant-approved support sessions: no account, tenant role, or standing grant.

use std::{collections::HashSet, str::FromStr, sync::OnceLock};

use cedar_policy::{
    Authorizer, Context, Decision, Entities, Entity, EntityId, EntityTypeName, EntityUid,
    PolicySet, Request, RestrictedExpression, Schema, ValidationMode, Validator,
};

use crate::{Feature, access};

/// The session transition or read being authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Request,
    OperatorApprove,
    TenantApprove,
    Start,
    End,
    Read,
    FieldRead,
}

impl Action {
    const ALL: [Self; 7] = [
        Self::Request,
        Self::OperatorApprove,
        Self::TenantApprove,
        Self::Start,
        Self::End,
        Self::Read,
        Self::FieldRead,
    ];

    const fn name(self) -> &'static str {
        match self {
            Self::Request => "support_request",
            Self::OperatorApprove => "support_operator_approve",
            Self::TenantApprove => "support_tenant_approve",
            Self::Start => "support_start",
            Self::End => "support_end",
            Self::Read => "support_read",
            Self::FieldRead => "support_field_read",
        }
    }
}

/// Support is a distinct Cedar entity, never an account with tenant roles.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrincipalKind {
    Operator,
    Tenant,
    Support,
}

/// Facts are loaded from current authority and the locked session, never JSON input.
#[derive(Debug, Clone, Copy, Default)]
pub struct Facts {
    pub active: bool,
    pub vendor: bool,
    pub step_up: bool,
    pub other_eligible_holders: i64,
    pub actor_is_requester: bool,
    pub actor_holds_permission: bool,
    pub operator_approved: bool,
    pub tenant_approved: bool,
    pub in_scope: bool,
    pub personal: bool,
    pub reveal_granted: bool,
}

const ENTITIES: &str = r#"entity Subject = { "org": String };
entity SupportPrincipal = { "org": String };
entity Resource = { "org": String };
"#;
const CONTEXT: &str = r#" appliesTo {
  principal: [Subject, SupportPrincipal], resource: [Resource],
  context: { "active": Bool, "vendor": Bool, "step_up": Bool,
    "other_eligible_holders": Long, "actor_is_requester": Bool,
    "actor_holds_permission": Bool, "operator_approved": Bool,
    "tenant_approved": Bool, "in_scope": Bool, "personal": Bool,
    "reveal_granted": Bool }
};
"#;
const POLICIES: &str = r#"permit(principal is Subject, action == Action::"support_request", resource)
when { context.active && context.vendor && context.step_up
  && context.actor_holds_permission && context.other_eligible_holders > 0 };
permit(principal is Subject, action == Action::"support_operator_approve", resource)
when { context.active && context.vendor && context.step_up
  && context.actor_holds_permission && context.other_eligible_holders > 0 };
@reason("support.refuse.requester_cannot_approve")
forbid(principal, action == Action::"support_operator_approve", resource)
when { context.actor_is_requester };
permit(principal is Subject, action == Action::"support_tenant_approve", resource)
when { context.active && !context.vendor && principal.org == resource.org
  && context.actor_holds_permission && context.operator_approved };
permit(principal is Subject, action == Action::"support_start", resource)
when { context.active && context.vendor && context.step_up
  && context.other_eligible_holders > 0 && context.actor_holds_permission
  && context.actor_is_requester && context.operator_approved && context.tenant_approved };
permit(principal is Subject, action == Action::"support_end", resource)
when { context.active && ((context.vendor && context.actor_is_requester)
  || (!context.vendor && principal.org == resource.org && context.actor_holds_permission)) };
"#;

struct Bundle {
    schema: Schema,
    policies: PolicySet,
}

fn read_policy(action: &str, field: bool) -> String {
    let mask = if field {
        " && (!context.personal || context.reveal_granted)"
    } else {
        ""
    };
    format!(
        "permit(principal is SupportPrincipal, action == Action::\"{action}\", resource)\n\
         when {{ principal.org == resource.org && context.active && context.in_scope\n\
         && context.operator_approved && context.tenant_approved{mask} }};\n"
    )
}

fn compile() -> Result<Bundle, String> {
    let mut schema = ENTITIES.to_owned();
    let mut policies = POLICIES.to_owned();
    for action in Action::ALL {
        schema.push_str(&format!("action \"{}\"{CONTEXT}", action.name()));
    }
    policies.push_str(&read_policy(Action::Read.name(), false));
    policies.push_str(&read_policy(Action::FieldRead.name(), true));
    for feature in Feature::ALL {
        schema.push_str(&format!("action \"{}\"{CONTEXT}", feature.as_str()));
        if matches!(access::tag(feature), Some((_, access::Level::View))) {
            policies.push_str(&read_policy(feature.as_str(), false));
        }
    }
    let schema = Schema::from_str(&schema).map_err(|e| e.to_string())?;
    let policies = PolicySet::from_str(&policies).map_err(|e| e.to_string())?;
    let validation = Validator::new(schema.clone()).validate(&policies, ValidationMode::Strict);
    if !validation.validation_passed_without_warnings() {
        return Err(validation
            .validation_errors()
            .map(ToString::to_string)
            .chain(validation.validation_warnings().map(ToString::to_string))
            .collect::<Vec<_>>()
            .join("; "));
    }
    Ok(Bundle { schema, policies })
}

fn evaluate(
    action: &str,
    kind: PrincipalKind,
    actor: &str,
    actor_org: &str,
    target_org: &str,
    f: Facts,
) -> Result<bool, String> {
    if (kind == PrincipalKind::Tenant && f.vendor) || (kind == PrincipalKind::Operator && !f.vendor)
    {
        return Ok(false);
    }
    static BUNDLE: OnceLock<Result<Bundle, String>> = OnceLock::new();
    let bundle = BUNDLE.get_or_init(compile).as_ref().map_err(Clone::clone)?;
    let uid = |kind: &str, id: &str| -> Result<EntityUid, String> {
        Ok(EntityUid::from_type_name_and_id(
            EntityTypeName::from_str(kind).map_err(|e| e.to_string())?,
            EntityId::new(id),
        ))
    };
    let principal = uid(
        if kind == PrincipalKind::Support {
            "SupportPrincipal"
        } else {
            "Subject"
        },
        actor,
    )?;
    let resource = uid("Resource", target_org)?;
    let entity = |id: EntityUid, org: &str| {
        Entity::new(
            id,
            [(
                "org".to_owned(),
                RestrictedExpression::new_string(org.to_owned()),
            )]
            .into(),
            HashSet::new(),
        )
        .map_err(|e| e.to_string())
    };
    let entities = Entities::from_entities(
        [
            entity(principal.clone(), actor_org)?,
            entity(resource.clone(), target_org)?,
        ],
        Some(&bundle.schema),
    )
    .map_err(|e| e.to_string())?;
    let values = [
        ("active", f.active),
        ("vendor", f.vendor && kind == PrincipalKind::Operator),
        ("step_up", f.step_up),
        ("actor_is_requester", f.actor_is_requester),
        ("actor_holds_permission", f.actor_holds_permission),
        ("operator_approved", f.operator_approved),
        ("tenant_approved", f.tenant_approved),
        ("in_scope", f.in_scope),
        ("personal", f.personal),
        ("reveal_granted", f.reveal_granted),
    ];
    let context = Context::from_pairs(
        values
            .into_iter()
            .map(|(key, value)| (key.to_owned(), RestrictedExpression::new_bool(value)))
            .chain(std::iter::once((
                "other_eligible_holders".to_owned(),
                RestrictedExpression::new_long(f.other_eligible_holders),
            ))),
    )
    .map_err(|e| e.to_string())?;
    let request = Request::new(
        principal,
        uid("Action", action)?,
        resource,
        context,
        Some(&bundle.schema),
    )
    .map_err(|e| e.to_string())?;
    let response = Authorizer::new().is_authorized(&request, &bundle.policies, &entities);
    Ok(response.decision() == Decision::Allow && response.diagnostics().errors().next().is_none())
}

/// Compile, validation and evaluation failures all deny the action.
#[must_use]
pub fn decide(
    action: Action,
    kind: PrincipalKind,
    actor: &str,
    actor_org: &str,
    target_org: &str,
    facts: Facts,
) -> bool {
    crate::cedar_stack::with_cedar_stack(|| {
        evaluate(action.name(), kind, actor, actor_org, target_org, facts).unwrap_or(false)
    })
}

/// The catalog owns read classification; unclassified and write actions default-deny.
#[must_use]
pub fn decide_feature(feature: Feature, session: &str, org: &str, facts: Facts) -> bool {
    crate::cedar_stack::with_cedar_stack(|| {
        evaluate(
            feature.as_str(),
            PrincipalKind::Support,
            session,
            org,
            org,
            facts,
        )
        .unwrap_or(false)
    })
}

/// The caller resolves the field class against the tenant's session grant.
#[must_use]
pub fn field_visible(personal: bool, grant_enables_class: bool) -> bool {
    !personal || grant_enables_class
}

#[cfg(test)]
mod tests {
    #[test]
    fn support_bundle_validates_strictly() {
        crate::cedar_stack::with_cedar_stack(|| {
            assert!(super::compile().is_ok());
        });
    }
}
