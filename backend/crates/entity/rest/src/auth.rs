//! Who may call what. Reads take `org_change_read`; 부서/팀 setup units keep
//! `org_change_apply`; 법인 · 사업자등록 · 사업장 writes take their own Cedar
//! action `legal_entity_manage` (decisions #14.2), decided with the scope
//! facts (decisions #15) and failing closed; placement writes take
//! `employee_directory_manage`. Restricted personal fields (대표자, 공동사업자)
//! go only to callers who may manage the record.

use axum::http::HeaderMap;
use console_entity_application::{Actor, EntityScope, Target};
use console_entity_domain::Refusal;
use console_kernel_core::{ErrorKind, KernelError, TraceContext};
use console_platform_authz::cedar_pbac::action_schema::compile_action_bundle;
use console_platform_authz::cedar_pbac::facts::scope::scope_facts;
use console_platform_authz::cedar_pbac::facts::{Facts, evaluate_with_facts};
use console_platform_authz::{
    Action, AuthorizationRequest, AuthorizationResource, CedarEvaluation, Feature, Principal,
    authorize_capability,
};
use uuid::Uuid;

use crate::EntityRestState;
use crate::error::RestError;

type Result<T> = std::result::Result<T, RestError>;

#[derive(Clone, Copy)]
pub(crate) enum Need {
    Read,
    /// 부서/팀 setup units: the org-change grant.
    Structure,
    People,
}

/// The tenant-wide reach, before [`scoped`] narrows it to the caller's grants.
const fn scope_of(_principal: &Principal) -> EntityScope {
    EntityScope::Tenant
}

/// The caller as an actor with their real reach (worst-case-08): reads,
/// counts and the Cedar scope facts stop at what their grants name.
async fn scoped(s: &EntityRestState, principal: &Principal) -> Result<Actor> {
    let mut actor = actor_of(principal);
    actor.scope = crate::reach::reach(&s.store, principal).await?;
    Ok(actor)
}

/// `legal_entity_manage` for a record whose own ids are `resource`.
fn may_manage(principal: &Principal, scope: &EntityScope, resource: &[Uuid]) -> bool {
    let feature = Feature::LegalEntityManage;
    let freshness = principal.authz_freshness;
    let Ok(bundle) = compile_action_bundle(principal.org_id, freshness.policy_version, feature)
    else {
        return false;
    };
    let request = AuthorizationRequest::new(
        principal.clone(),
        Action::new(feature),
        AuthorizationResource::org_wide(principal.org_id, "legal_entity"),
    )
    .with_subject_freshness(freshness);
    let facts = scope_facts(Facts::new(), scope.granted(), resource);
    matches!(
        evaluate_with_facts(&request, &bundle, &facts),
        CedarEvaluation::Allow { .. }
    )
}

pub(crate) async fn principal(s: &EntityRestState, headers: &HeaderMap) -> Result<Principal> {
    let verifier = s.jwt_verifier.as_ref().ok_or_else(|| {
        Refusal::new(
            ErrorKind::Internal,
            "unavailable",
            "JWT verification is not configured",
        )
    })?;
    Ok(
        console_platform_request_context::resolve_principal(verifier, s.store.pool(), headers)
            .await?,
    )
}

fn actor_of(principal: &Principal) -> Actor {
    Actor {
        org: principal.org_id,
        user: principal.user_id,
        trace: TraceContext::generate(),
        command_id: None,
        scope: scope_of(principal),
    }
}

/// Decides `legal_entity_manage` for one record after the read (the reader's
/// verbs: worst-case-08 offers only what the grant allows).
pub(crate) struct Gate {
    principal: Principal,
    scope: EntityScope,
}

impl Gate {
    /// Whether the reader may manage the record whose own ids are `resource`.
    pub(crate) fn may(&self, resource: &[Uuid]) -> bool {
        may_manage(&self.principal, &self.scope, resource)
    }
}

/// A reader, and whether it may see restricted personal fields of `target`.
pub(crate) async fn actor(
    s: &EntityRestState,
    headers: &HeaderMap,
    need: Need,
    target: Target,
) -> Result<(Actor, bool)> {
    let (actor, personal, _) = read_gate(s, headers, need, target).await?;
    Ok((actor, personal))
}

/// [`actor`], plus the gate that decides each record's verbs.
pub(crate) async fn read_gate(
    s: &EntityRestState,
    headers: &HeaderMap,
    need: Need,
    target: Target,
) -> Result<(Actor, bool, Gate)> {
    let principal = principal(s, headers).await?;
    let feature = match need {
        Need::Read => Feature::OrgChangeRead,
        Need::Structure => Feature::OrgChangeApply,
        Need::People => Feature::EmployeeDirectoryManage,
    };
    authorize_capability(&principal, Action::new(feature))?;
    let actor = scoped(s, &principal).await?;
    let resource = s.store.target_ids(&actor, target).await?;
    let personal = may_manage(&principal, &actor.scope, &resource);
    let gate = Gate {
        principal,
        scope: actor.scope.clone(),
    };
    Ok((actor, personal, gate))
}

/// A write's actor: its `Idempotency-Key` (a UUID) is the command id, so a
/// retried request is applied once (INTEG-1).
fn with_key(mut actor: Actor, headers: &HeaderMap) -> Result<Actor> {
    let key = headers
        .get("Idempotency-Key")
        .ok_or_else(|| Refusal::field("Idempotency-Key", "required"))?;
    let id = key
        .to_str()
        .ok()
        .and_then(|k| Uuid::parse_str(k.trim()).ok())
        .ok_or_else(|| Refusal::field("Idempotency-Key", "invalid_uuid"))?;
    actor.command_id = Some(id);
    Ok(actor)
}

/// A setup-unit or placement writer (legacy permissions).
pub(crate) async fn writer(s: &EntityRestState, headers: &HeaderMap, need: Need) -> Result<Actor> {
    let (actor, _) = actor(s, headers, need, Target::Tenant).await?;
    with_key(actor, headers)
}

/// A 법인 · 사업자등록 · 사업장 writer: `legal_entity_manage` on `target`.
pub(crate) async fn manager(
    s: &EntityRestState,
    headers: &HeaderMap,
    target: Target,
) -> Result<Actor> {
    Ok(manager_or_ops(s, headers, target).await?.0)
}

/// [`manager`], and whether the caller is the tenant ops account (the
/// break-glass second person, decisions #26 item d).
pub(crate) async fn manager_or_ops(
    s: &EntityRestState,
    headers: &HeaderMap,
    target: Target,
) -> Result<(Actor, bool)> {
    let principal = principal(s, headers).await?;
    let actor = scoped(s, &principal).await?;
    let resource = s.store.target_ids(&actor, target).await?;
    if !may_manage(&principal, &actor.scope, &resource) {
        return Err(KernelError::forbidden("legal_entity_manage is not allowed").into());
    }
    Ok((with_key(actor, headers)?, principal.is_tenant_ops))
}

/// A bulk 법인 · 사업장 writer (MR-29): `legal_entity_manage` on every
/// subject of the batch (C16: each one evaluated, any refusal denies all).
/// A dry run writes nothing and needs no `Idempotency-Key`.
pub(crate) async fn manager_of(
    s: &EntityRestState,
    headers: &HeaderMap,
    targets: &[Target],
    write: bool,
) -> Result<Actor> {
    let principal = principal(s, headers).await?;
    let actor = scoped(s, &principal).await?;
    // No subject (an empty batch) is checked as the tenant: never unchecked.
    let tenant = [Target::Tenant];
    for &target in if targets.is_empty() {
        &tenant[..]
    } else {
        targets
    } {
        let resource = s.store.target_ids(&actor, target).await?;
        if !may_manage(&principal, &actor.scope, &resource) {
            return Err(KernelError::forbidden("legal_entity_manage is not allowed").into());
        }
    }
    if write {
        with_key(actor, headers)
    } else {
        Ok(actor)
    }
}

// --- lane: CRUD ---
/// Cedar `org_unit_manage` (direct 부서 erase, 폐지, 부서장 · 코드): its one
/// fact is a tenant-wide `org_change_apply` door (the ops account holds it).
fn may_change_units(principal: &Principal) -> bool {
    let holds = authorize_capability(principal, Action::new(Feature::OrgChangeApply)).is_ok();
    let facts = Facts::new().bool("actor_holds_permission", holds);
    let resource = AuthorizationResource::org_wide(principal.org_id, "org_unit");
    console_platform_authz::cedar_pbac::enforce::enforce_action(
        principal,
        Feature::OrgUnitManage,
        resource,
        &facts,
    )
    .is_ok()
}

/// A direct 부서 writer: 403 unless Cedar allows `org_unit_manage`.
pub(crate) async fn unit_manager(s: &EntityRestState, headers: &HeaderMap) -> Result<Actor> {
    let principal = principal(s, headers).await?;
    if !may_change_units(&principal) {
        return Err(KernelError::forbidden("org_unit_manage is not allowed").into());
    }
    with_key(actor_of(&principal), headers)
}

/// A reader of a unit's end options, and whether it may act on them.
pub(crate) async fn unit_reader(s: &EntityRestState, headers: &HeaderMap) -> Result<(Actor, bool)> {
    let principal = principal(s, headers).await?;
    authorize_capability(&principal, Action::new(Feature::OrgChangeRead))?;
    Ok((actor_of(&principal), may_change_units(&principal)))
}

/// A reader of a 법인/사업장's end options, and whether it may manage `target`.
pub(crate) async fn record_reader(
    s: &EntityRestState,
    headers: &HeaderMap,
    target: Target,
) -> Result<(Actor, bool)> {
    actor(s, headers, Need::Read, target).await
}
