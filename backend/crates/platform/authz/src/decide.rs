use console_kernel_core::{BranchId, BranchScope, KernelError, Timestamp};

use crate::{Action, Feature, PermissionLevel, Principal, ResourceBranch, Role, ServicePrincipal};

/// Return one role's matrix cell for one feature.
#[must_use]
pub fn permission_for(role: Role, feature: Feature) -> PermissionLevel {
    feature.matrix_row()[role.matrix_index()]
}

pub(crate) const fn feature_available_in_v1(feature: Feature) -> bool {
    !matches!(feature, Feature::AiAssist)
}

/// Authorize a principal for an org-wide feature read/action with no concrete
/// resource branch in the request. This is the single source of truth for
/// branch-omitted org-wide routes: callers must already have `BranchScope::All`,
/// built-in org-wide authority is limited to `SUPER_ADMIN`/`EXECUTIVE`, and
/// custom-role grants must themselves be org-wide (`BranchScope::All`) to pass
/// this gate. Branch-narrow custom grants may still authorize concrete branch
/// requests through [`authorize`], but never widen into an all-branch read.
pub fn authorize_org_wide(principal: &Principal, action: Action) -> Result<(), KernelError> {
    if !feature_available_in_v1(action.feature()) {
        return Err(KernelError::forbidden("feature is unavailable in v1"));
    }
    if principal.branch_scope != BranchScope::All {
        return Err(KernelError::forbidden(
            "org-wide access requires all-branch scope",
        ));
    }

    let has_builtin_org_wide_permission = principal.roles.iter().any(|role| {
        matches!(role, Role::SuperAdmin | Role::Executive)
            && permission_for(*role, action.feature()).satisfies(action.required_permission())
    });
    let has_custom_org_wide_permission = principal.effective_feature_grants.iter().any(|grant| {
        grant.feature == action.feature()
            && grant.permission.satisfies(action.required_permission())
            && grant.branch_scope == BranchScope::All
    });

    if !(has_builtin_org_wide_permission || has_custom_org_wide_permission) {
        return Err(KernelError::forbidden("role is not allowed to use feature"));
    }

    Ok(())
}

/// Authorize a principal for a feature whose resource carries NO BRANCH AT ALL —
/// a workflow run, a workflow definition, a sales listing, an evaluation cycle:
/// rows whose table has no `branch_id` column, and list gates whose confinement
/// is the caller's whole `branch_scope` rather than one branch.
///
/// Complete the set:
/// * [`authorize`] — the resource HAS a branch; pass THAT branch. Never pass a
///   branch derived from `principal.branch_scope`. `authorize` checks
///   `principal.branch_scope.allows(resource_branch)` first, so a
///   principal-derived branch makes that check a TAUTOLOGY on both arms: `All`
///   allows any fabricated id, and `Branches(set).iter().next()` is by
///   definition a member of `set`. The branch dimension then vanishes silently
///   instead of visibly. If you were about to write
///   `match principal.branch_scope { All => BranchId::new(), Branches(b) =>
///   b.iter().next() }` — or the `.iter().any(|b| authorize(.., *b).is_ok())`
///   variant, which is the same tautology, only wordier — you want THIS
///   function. `console-gate-fabricated-branch` fails CI if you write it anyway.
/// * [`authorize_org_wide`] — the ACTION spans every branch. Requires the caller
///   to already hold `BranchScope::All` and limits built-in authority to
///   `SUPER_ADMIN`/`EXECUTIVE`. Do NOT reach for it merely because a branch is
///   unavailable: it denies every branch-scoped principal and every ADMIN.
///
/// The built-in-role arm is byte-identical to [`authorize`]'s, which never
/// consults the branch — so for every principal whose access comes from a
/// built-in role the verdict is unchanged by construction.
///
/// # The one behavioural delta in this migration
///
/// The custom-grant arm requires the grant to COVER the principal's whole scope
/// (`grant ⊇ principal`) rather than merely to allow one branch of it. This is
/// the only place any verdict moves, and it moves in one direction: `grant ⊇ p`
/// implies `grant.allows(b)` for every `b ∈ p`, so nothing this admits was denied
/// before. For an `All`-scoped principal it collapses to exactly
/// [`authorize_org_wide`]'s `grant.branch_scope == BranchScope::All`; for a
/// single-branch principal `grant ⊇ {b}` IS `grant.allows(b)`. Both are unchanged.
///
/// **Who loses access.** Exactly one class: a principal holding TWO OR MORE
/// branches, with no built-in role permission for the feature, whose custom
/// (PBAC) grant covers some but not all of those branches. A `{seoul, busan}`
/// principal with a Seoul-only grant is denied here and may have been allowed
/// before.
///
/// **Why that is correct.** "May have been" is the point: what this replaced was
/// not a policy, it was a sort order. The fabricated check authorized against
/// `branches.iter().next()` — the LOWEST-SORTING branch UUID of a `BTreeSet` — so
/// the identical partial grant admitted or denied depending on which random id
/// happened to sort first. Nothing in the product means that, and no operator
/// could predict it. Deterministic deny replaces a coin flip, and it is the
/// conservative side of the flip.
///
/// Deny is also the right answer on the merits: these are the sites where nothing
/// downstream narrows to a branch. A branch-less row has no branch to confine by,
/// and a list gate's confinement IS the caller's whole `branch_scope` — so a grant
/// covering part of that scope cannot authorize an action that reaches all of it.
/// The remedy for an affected tenant is to widen the grant to the principal's
/// scope, which is what the grant already meant to say.
///
/// Pinned by `capability_replaces_an_order_dependent_grant_verdict_with_a_deny`;
/// recorded in `docs/decisions/notes/DN-0004-adr-0028-branchless-capability-authorization.md`.
pub fn authorize_capability(principal: &Principal, action: Action) -> Result<(), KernelError> {
    authorize_inner(principal, action, None, None)
}

/// [`authorize_capability`] at a decision instant — the branch-LESS half of the
/// spine, and the ONLY door that takes no resource.
///
/// It is a separate function rather than a `None` on [`authorize_scoped`] on
/// purpose. An `Option<ResourceBranch>` parameter is a type boundary its own
/// caller can step around: every fabricating call site that
/// [`ResourceBranch`] makes uncompilable stays compilable by passing `None`,
/// and the branch dimension disappears exactly as silently as it did before —
/// a convention wearing a type's clothes. With two doors there is no argument
/// to omit, so CONVERTING a branch-scoped call site to the branch-less one is a
/// changed function name and visible in a diff.
///
/// That is the whole of the claim. A NEW handler for a branch-scoped resource
/// can still call this one and drop the branch dimension exactly as quietly as
/// `authorize_scoped(.., None, ..)` did — nothing here can tell that its caller
/// had a resource. Choosing the right door is still a judgement; the split only
/// removes the way to get it wrong by omission.
///
/// The temporal contract is [`authorize_scoped`]'s: `at` is the decision
/// instant, [`Principal::dated_feature_grants`] are resolved against it on
/// every call, and nothing is carried across the boundary (ADR-0032 §3, §6).
///
/// # Errors
///
/// [`console_kernel_core::ErrorKind::Forbidden`] when the principal has no
/// branch scope at all, or when neither a built-in role nor a grant effective
/// AT `at` and covering that whole scope permits the action.
pub fn authorize_capability_at(
    principal: &Principal,
    action: Action,
    at: Timestamp,
) -> Result<(), KernelError> {
    authorize_inner(principal, action, None, Some(at))
}

/// The single body behind [`authorize`], [`authorize_capability`] and
/// [`authorize_scoped`], so the branch dimension and the grant predicate cannot
/// drift apart across three copies.
///
/// `branch` is the whole difference between the two doors:
/// * `Some(b)` — the resource HAS a branch. Membership is
///   `branch_scope.allows(b)`, and a custom grant qualifies when it allows `b`.
/// * `None` — the resource has NO branch, so confinement IS the caller's whole
///   scope. Membership is "the scope is non-empty" (without it,
///   `intersect({}, {}) == {}` makes the coverage test below vacuously true and
///   a membership-less principal would be authorized by any grant it holds; every
///   fabricating helper this replaced denied that principal, and
///   `BranchScope::none` is documented as "allows nothing"), and a custom grant
///   qualifies only when it COVERS that whole scope.
///
/// `at` is the decision instant, and it is the only temporal input.
/// * `Some(at)` — [`Principal::dated_feature_grants`] are resolved against it,
///   per call, never memoised and never carried across the decision boundary
///   (ADR-0032 §3).
/// * `None` — this door was given no instant, so it cannot resolve a dated
///   grant and does not guess. It sees only the interval-less grants, which
///   fails CLOSED (§6): an effective-dated grant can never widen a decision
///   that could not have checked its dates.
fn authorize_inner(
    principal: &Principal,
    action: Action,
    branch: Option<BranchId>,
    at: Option<Timestamp>,
) -> Result<(), KernelError> {
    if !feature_available_in_v1(action.feature()) {
        return Err(KernelError::forbidden("feature is unavailable in v1"));
    }
    match branch {
        Some(resource_branch) => {
            if !principal.branch_scope.allows(resource_branch) {
                return Err(KernelError::forbidden(
                    "resource branch is outside principal scope",
                ));
            }
        }
        None => {
            if principal.branch_scope.is_empty() {
                return Err(KernelError::forbidden("principal has no branch scope"));
            }
        }
    }

    // Resolved HERE, at the decision, and dropped when it returns.
    let effective_now = principal
        .effective_feature_grants
        .iter()
        .chain(at.into_iter().flat_map(|at| {
            principal
                .dated_feature_grants
                .iter()
                .filter_map(move |dated| dated.resolve(at))
        }));

    let has_feature_permission = principal.roles.iter().any(|role| {
        permission_for(*role, action.feature()).satisfies(action.required_permission())
    }) || effective_now.into_iter().any(|grant| {
        grant.feature == action.feature()
            && grant.permission.satisfies(action.required_permission())
            && match branch {
                Some(resource_branch) => grant.branch_scope.allows(resource_branch),
                None => {
                    grant.branch_scope.intersect(&principal.branch_scope) == principal.branch_scope
                }
            }
    });

    if !has_feature_permission {
        return Err(KernelError::forbidden("role is not allowed to use feature"));
    }

    Ok(())
}

/// The BRANCH-SCOPED authorization door: the decision instant is an argument and
/// the resource's branch is a value that only Postgres can have produced.
///
/// `resource` is branch authorization, identical to [`authorize`], against a
/// branch that came off the RESOURCE. It cannot have come from anywhere else:
/// [`ResourceBranch`] has no constructor that takes a `BranchId`, so the
/// fabricating shapes do not compile rather than needing to be recognised.
///
/// When the resource has NO branch — no `branch_id` column, or a list gate whose
/// confinement is the caller's whole scope — the door is
/// [`authorize_capability_at`], which is a different function and not an omitted
/// argument. This one took `Option<ResourceBranch>` until the option was removed:
/// a boundary a caller can step around by passing `None` is a convention, not a
/// type, and `None` is the one spelling of a fabricated branch that a compiler
/// cannot object to.
///
/// `at` is the instant the decision is made. The grant set is resolved against
/// it on every call and the result is never cached across the boundary
/// (ADR-0032 §3). Crossing `valid_from` or `valid_to` is not a write, so no
/// freshness counter can record it and nothing but re-evaluating the predicate
/// can notice it (§6).
///
/// # The parameter IS a `ResourceBranch`
///
/// THE CONTROL, and the positive form of the claim: the signature is asserted
/// whole, so re-widening the parameter is a compile error here rather than a
/// convention nobody re-reads.
///
/// ```
/// use console_kernel_core::{KernelError, Timestamp};
/// use console_platform_authz::{Action, Principal, ResourceBranch, authorize_scoped};
///
/// let branch_scoped_door: fn(&Principal, Action, ResourceBranch, Timestamp)
///     -> Result<(), KernelError> = authorize_scoped;
/// ```
///
/// The same coercion with the parameter back in an `Option` — one token's
/// difference — no longer describes this function:
///
/// ```compile_fail,E0308
/// use console_kernel_core::{KernelError, Timestamp};
/// use console_platform_authz::{Action, Principal, ResourceBranch, authorize_scoped};
///
/// let branch_scoped_door: fn(&Principal, Action, Option<ResourceBranch>, Timestamp)
///     -> Result<(), KernelError> = authorize_scoped;
/// ```
///
/// # A fabricated branch does not compile
///
/// The branch-LESS call is ordinary, and it is its own function:
///
/// ```
/// use std::collections::BTreeSet;
///
/// use console_kernel_core::{BranchId, BranchScope, OrgId, Timestamp, UserId};
/// use console_platform_authz::{Action, Feature, Principal, Role, authorize_capability_at};
///
/// let principal = Principal::new(
///     UserId::new(),
///     OrgId::one(),
///     BTreeSet::from([Role::Admin]),
///     BranchScope::single(BranchId::new()),
/// );
/// let decision = authorize_capability_at(
///     &principal,
///     Action::new(Feature::CompletionReview),
///     Timestamp::now_utc(),
/// );
/// assert!(decision.is_ok());
/// ```
///
/// Aiming that same call at the branch-scoped door with a minted branch is
/// rejected by the compiler, not by a scan:
///
/// ```compile_fail,E0308
/// use std::collections::BTreeSet;
///
/// use console_kernel_core::{BranchId, BranchScope, OrgId, Timestamp, UserId};
/// use console_platform_authz::{Action, Feature, Principal, Role, authorize_scoped};
///
/// let principal = Principal::new(
///     UserId::new(),
///     OrgId::one(),
///     BTreeSet::from([Role::Admin]),
///     BranchScope::single(BranchId::new()),
/// );
/// let decision = authorize_scoped(
///     &principal,
///     Action::new(Feature::CompletionReview),
///     BranchId::new(),
///     Timestamp::now_utc(),
/// );
/// assert!(decision.is_ok());
/// ```
///
/// # Nor does `None`, because that is not a resource
///
/// The escape hatch this door used to have. It is the identical example with the
/// branch replaced by `None` and nothing else changed:
///
/// ```compile_fail,E0308
/// use std::collections::BTreeSet;
///
/// use console_kernel_core::{BranchId, BranchScope, OrgId, Timestamp, UserId};
/// use console_platform_authz::{Action, Feature, Principal, Role, authorize_scoped};
///
/// let principal = Principal::new(
///     UserId::new(),
///     OrgId::one(),
///     BTreeSet::from([Role::Admin]),
///     BranchScope::single(BranchId::new()),
/// );
/// let decision = authorize_scoped(
///     &principal,
///     Action::new(Feature::CompletionReview),
///     None,
///     Timestamp::now_utc(),
/// );
/// ```
///
/// # The TENANT is checked here, not trusted from the lookup
///
/// [`ResourceBranch::lookup`] binds `org_id` in its statement, but the org it
/// binds is an argument: a handler that takes it from the same request path as
/// the row id (`path.org_id`) names a tenant the principal need not belong to,
/// and the lookup then succeeds against THAT tenant's row. For a
/// `BranchScope::All` principal `allows(branch)` is unconditionally true, so
/// the decision would be an ALLOW against another tenant's resource.
///
/// So the branch carries the org it was read under and this door compares it to
/// the principal's own. The tenant cannot be supplied independently of the
/// principal being authorized — it can only be supplied wrongly, which denies.
///
/// # Errors
///
/// [`console_kernel_core::ErrorKind::Forbidden`] when the resource was read
/// under a different tenant than the principal's, when the resource branch is
/// outside the principal's scope, or when neither a built-in role nor a grant
/// effective AT `at` permits the action.
pub fn authorize_scoped(
    principal: &Principal,
    action: Action,
    resource: ResourceBranch,
    at: Timestamp,
) -> Result<(), KernelError> {
    if resource.org() != principal.org_id {
        return Err(KernelError::forbidden(
            "resource was read under a different tenant than the principal",
        ));
    }

    authorize_inner(principal, action, Some(resource.get()), Some(at))
}

/// Authorize a principal for a feature against a concrete resource branch.
///
/// This intentionally checks both role permission and branch membership for
/// every call. Listing APIs should also use [`repository_filter`] so the data
/// access path is constrained before rows are materialized.
///
/// # The branch must come from the RESOURCE
///
/// `resource_branch` must be read off the row being authorized. A branch derived
/// from `principal.branch_scope` makes the first check a tautology on BOTH arms
/// — `All` allows a fresh `BranchId::new()`, and `branches.iter().next()` is a
/// member of `branches` by definition — which silently deletes the branch
/// dimension instead of enforcing it. When the resource genuinely has no branch,
/// call [`authorize_capability`]; when the action genuinely spans every branch,
/// call [`authorize_org_wide`]. `console-gate-fabricated-branch` fails CI on the
/// fabricating shapes.
///
/// # A [`ResourceBranch`] cannot be unwrapped into this door
///
/// This door takes a bare [`BranchId`] and so has no tenant to compare: a caller
/// that unwrapped a [`ResourceBranch`] here would reach the same decision while
/// skipping the org check only [`authorize_scoped`] performs, which is an ALLOW
/// against another tenant's resource for any `BranchScope::All` principal. That
/// spelling does not exist — the branch accessor is crate-private, so the
/// unwrap does not compile outside this crate:
///
/// ```compile_fail,E0624
/// fn unwrap_the_resource(
///     resource: console_platform_authz::ResourceBranch,
/// ) -> console_kernel_core::BranchId {
///     resource.get()
/// }
/// ```
///
/// THE CONTROL, and a one-token delta: the same argument, the same call syntax,
/// the accessor that IS public — so the failure above is the unwrap and not the
/// imports, the type name or the method-call shape.
///
/// ```
/// fn read_the_tenant(
///     resource: console_platform_authz::ResourceBranch,
/// ) -> console_kernel_core::OrgId {
///     resource.org()
/// }
/// ```
///
/// [`repository_filter`]: fn@crate::repository_filter
pub fn authorize(
    principal: &Principal,
    action: Action,
    resource_branch: BranchId,
) -> Result<(), KernelError> {
    authorize_inner(principal, action, Some(resource_branch), None)
}

/// Authorize a machine principal. Unlike [`authorize`], this cannot inherit a
/// human role or tenant custom grant: both the exact feature and exact branch
/// must match the credential registration.
pub fn authorize_service(
    principal: &ServicePrincipal,
    action: Action,
    resource_branch: BranchId,
) -> Result<(), KernelError> {
    if !feature_available_in_v1(action.feature())
        || principal.feature != action.feature()
        || principal.branch_id != resource_branch
    {
        return Err(KernelError::forbidden(
            "service principal is not authorized for resource",
        ));
    }
    Ok(())
}
