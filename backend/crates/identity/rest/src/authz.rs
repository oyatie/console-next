use crate::error::RestError;
use console_kernel_core::BranchScope;
use console_platform_authz::Action;
use console_platform_authz::Feature;
use console_platform_authz::Principal;
use console_platform_authz::authorize_capability;

// ---------------------------------------------------------------------------
// Passkey self-management handlers (any authenticated user, OWN credentials)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Authz helpers
// ---------------------------------------------------------------------------

/// Authorize an org-management feature as a CAPABILITY: may this caller manage
/// org structure at all.
///
/// This is not a claim that the managed rows have no branch identity. A branch
/// obviously has one — it IS one — and `update_branch`/`deactivate_branch` take a
/// branch id straight off the path. What this function replaced could not check
/// that id either: it authorized against
/// `representative_branch(&principal.branch_scope)`, a branch taken from the
/// CALLER, so `authorize`'s `branch_scope.allows(..)` was true by construction on
/// both arms and only the feature matrix ever decided. The swap to
/// [`authorize_capability`] is therefore verdict-identical — it makes the missing
/// branch dimension visible instead of faking it, and neither opens nor closes a
/// cross-branch hole.
///
/// Confining a branch mutation to the caller's own scope belongs where the TARGET
/// id is known — `PgOrgStore::update_branch` / `deactivate_branch`, comparing the
/// caller's scope against `command.branch_id`. As of this commit
/// `UpdateBranchCommand`/`DeactivateBranchCommand` carry no scope field and that
/// comparison does not exist yet; closing it is the identity lane's open work, and
/// it is the only thing that can stop a cross-branch edit. A representative-branch
/// call here never could, which is why removing it costs nothing. Reads already
/// carry their own scope resolution (`directory_read_scope`), as do elevated-role
/// writes (`authorize_user_write`).
///
/// NOT `authorize_org_wide`: `UserManage`/`BranchManage`/`RegionManage` are ALLOW
/// for built-in ADMIN, and `Login` is ALLOW for every role; org-wide routing would
/// deny every branch-scoped principal here.
pub(crate) fn authorize_org_manage(
    principal: &Principal,
    feature: Feature,
) -> Result<(), RestError> {
    authorize_capability(principal, Action::new(feature)).map_err(RestError::from_kernel)
}

/// The people-directory read scope; no allow is a 403.
pub(crate) fn directory_read_scope(principal: &Principal) -> Result<BranchScope, RestError> {
    console_platform_authz::directory_read_scope(principal)
        .ok_or_else(|| RestError::forbidden("people directory access is denied"))
}
