//! AX-5: the per-person and per-place HR gates, decided over the caller's
//! grant set (`authz_reach.rs`). Each door keeps, for a legacy role that holds
//! no grant for the key, the tier it had before: [`Tier::Tenant`] for the
//! doors that were whole-tenant (a legacy branch role is refused, as before),
//! [`Tier::Branch`] for the directory reads that were branch-scoped (BW-22: a
//! person outside the role's branches reads as not found, as before). A grant
//! holder outside its scope gets the typed `out_of_scope`.

use console_kernel_core::KernelError;
use console_platform_authz::{Feature, Principal};
use uuid::Uuid;

use super::reach::{self, HrReach, holds_scoped, out_of_scope, person_in_reach, place_in_reach};
use super::{authorize_hr_org_wide, authorize_hr_scoped, authorize_hr_scoped_write};
use crate::HrError;

/// The gate a door kept for a legacy role with no grant for the key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    /// The door was whole-tenant (`authorize_hr_org_wide`).
    Tenant,
    /// The door was branch-scoped (`authorize_hr_scoped`, BW-22).
    Branch,
}

/// The reach of `feature` for a door of `tier`.
pub fn hr_reach_in(
    principal: &Principal,
    feature: Feature,
    tier: Tier,
) -> Result<HrReach, HrError> {
    reach::hr_reach_with(principal, feature, || match tier {
        Tier::Tenant => authorize_hr_org_wide(principal, feature),
        Tier::Branch => authorize_hr_scoped(principal, feature),
    })
}

/// The refusal for a person outside `reach`: a legacy branch role's is the
/// not-found it always was (BW-22); a grant holder's is `out_of_scope`.
fn refuse(principal: &Principal, feature: Feature, reach: &HrReach) -> HrError {
    match reach {
        HrReach::Within { scope, .. } if scope.is_empty() => HrError::from_kernel(
            KernelError::not_found("employee was not found in this organization"),
        ),
        _ => out_of_scope(principal, feature),
    }
}

/// `feature` on one person for a door of `tier`. Outside the reach — or no such
/// person — is one refusal (no existence leak); a whole-tenant holder passes
/// here and gets the door's own `not_found`.
pub async fn authorize_hr_person_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    feature: Feature,
    employee_id: Uuid,
    tier: Tier,
) -> Result<(), HrError> {
    let reach = hr_reach_in(principal, feature, tier)?;
    if person_in_reach(tx, &reach, employee_id).await? {
        Ok(())
    } else {
        Err(refuse(principal, feature, &reach))
    }
}

/// Whether `principal` may use `feature` on one person for a door of `tier`
/// (a lesser view is chosen on `false`, never an error).
pub async fn hr_may_person_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    feature: Feature,
    employee_id: Uuid,
    tier: Tier,
) -> Result<bool, HrError> {
    match hr_reach_in(principal, feature, tier) {
        Ok(reach) => person_in_reach(tx, &reach, employee_id).await,
        Err(_) => Ok(false),
    }
}

/// The reach of `feature` for a door that was whole-tenant ([`Tier::Tenant`]).
pub fn hr_reach(principal: &Principal, feature: Feature) -> Result<HrReach, HrError> {
    hr_reach_in(principal, feature, Tier::Tenant)
}

/// AX-5: `feature` on one person, decided over the grant set. Outside it — or
/// no such person — is the same 403 `out_of_scope` (no existence leak); an
/// `feature` on one person for a door that was whole-tenant.
pub async fn authorize_hr_person(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    feature: Feature,
    employee_id: Uuid,
) -> Result<(), HrError> {
    authorize_hr_person_in(tx, principal, feature, employee_id, Tier::Tenant).await
}

/// An exit-case step on one person: the case's branch for a legacy branch
/// role, else the person inside the grant set (AX-5).
pub async fn authorize_hr_case(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    feature: Feature,
    branch_id: Option<Uuid>,
    employee_id: Uuid,
) -> Result<(), HrError> {
    if holds_scoped(principal, feature) {
        return authorize_hr_person(tx, principal, feature, employee_id).await;
    }
    authorize_hr_scoped_write(principal, feature, branch_id)
}

/// The keys a 발령 (a lifecycle event) passes on: 발령 등록·수정, or — as
/// before AX-5 — 인사기본 등록·수정.
pub const APPOINTMENT_KEYS: [Feature; 2] =
    [Feature::LifecycleManage, Feature::EmployeeDirectoryManage];

/// AX-5: any of `features` on one person; the first key's refusal otherwise.
pub async fn authorize_hr_person_any(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    features: &[Feature],
    employee_id: Uuid,
) -> Result<(), HrError> {
    let mut first = None;
    for feature in features {
        match authorize_hr_person(tx, principal, *feature, employee_id).await {
            Ok(()) => return Ok(()),
            Err(err) => {
                first.get_or_insert(err);
            }
        }
    }
    Err(first.unwrap_or_else(|| out_of_scope(principal, Feature::EmployeeDirectoryManage)))
}

/// AX-5: any of `features` into a place; the first key's refusal otherwise.
pub async fn authorize_hr_place_any(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    features: &[Feature],
    place: (Option<Uuid>, Option<Uuid>, Option<Uuid>),
) -> Result<(), HrError> {
    let mut first = None;
    for feature in features {
        match authorize_hr_place(tx, principal, *feature, place).await {
            Ok(()) => return Ok(()),
            Err(err) => {
                first.get_or_insert(err);
            }
        }
    }
    Err(first.unwrap_or_else(|| out_of_scope(principal, Feature::EmployeeDirectoryManage)))
}

/// Whether `principal` holds any of `features` anywhere (the cheap pre-check
/// before a transaction; the per-resource decision follows inside it).
pub fn hr_reach_any(principal: &Principal, features: &[Feature]) -> Result<(), HrError> {
    let mut first = None;
    for feature in features {
        match hr_reach(principal, *feature) {
            Ok(_) => return Ok(()),
            Err(err) => {
                first.get_or_insert(err);
            }
        }
    }
    Err(first.unwrap_or_else(|| out_of_scope(principal, Feature::EmployeeDirectoryManage)))
}

/// Whether `principal` may use `feature` on one person, for a door that was
/// whole-tenant.
pub async fn hr_may_person(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    feature: Feature,
    employee_id: Uuid,
) -> Result<bool, HrError> {
    hr_may_person_in(tx, principal, feature, employee_id, Tier::Tenant).await
}

/// AX-5: `feature` into a place (a registration or a move target), decided
/// over the grant set; outside it is 403 `out_of_scope`.
pub async fn authorize_hr_place(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    principal: &Principal,
    feature: Feature,
    place: (Option<Uuid>, Option<Uuid>, Option<Uuid>),
) -> Result<(), HrError> {
    let reach = hr_reach(principal, feature)?;
    let (entity, workplace, unit) = place;
    if place_in_reach(tx, &reach, entity, workplace, unit).await? {
        Ok(())
    } else {
        Err(out_of_scope(principal, feature))
    }
}
