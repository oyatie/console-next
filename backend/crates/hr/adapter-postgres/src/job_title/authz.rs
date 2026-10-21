//! Who may change the classification catalog: Cedar's `job_title_manage`
//! (fail-closed). The one fact is computed from the principal's own doors:
//! a tenant-wide `job_title_manage` or `org_change_apply` (the org structure
//! grant; the tenant ops account holds it). A 법인/사업장-scoped grant never
//! reaches the tenant-wide lists.

use console_platform_authz::cedar_pbac::enforce::enforce_action;
use console_platform_authz::cedar_pbac::facts::Facts;
use console_platform_authz::{AuthorizationResource, Feature, Principal};

use crate::HrError;
use crate::authz::authorize_hr_org_wide;

fn holds(principal: &Principal) -> bool {
    [Feature::JobTitleManage, Feature::OrgChangeApply]
        .into_iter()
        .any(|feature| authorize_hr_org_wide(principal, feature).is_ok())
}

/// `Forbidden` unless Cedar allows the change.
pub(super) fn authorize_manage(principal: &Principal) -> Result<(), HrError> {
    let facts = Facts::new().bool("actor_holds_permission", holds(principal));
    let resource = AuthorizationResource::org_wide(principal.org_id, "job_title");
    enforce_action(principal, Feature::JobTitleManage, resource, &facts)
        .map_err(HrError::from_kernel)
}

/// Whether the inline 「+ 추가」 is offered (the same decision, no error).
pub(super) fn may_manage(principal: &Principal) -> bool {
    authorize_manage(principal).is_ok()
}
