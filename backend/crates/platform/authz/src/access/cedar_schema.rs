// SPDX-License-Identifier: LicenseRef-Proprietary
use super::catalog::{Domain, action_group};
use super::tags::tagged;

const APPLIES: &str =
    "appliesTo { principal: [Account], resource: [Tenant, LegalEntity, Workplace, Dept] };";

/// Tenant-wide setup editors and the live ops holder may read historical setup facts.
pub const GO_LIVE_RECEIPT_READ: &str = "onboarding_go_live_receipt_read";

pub const BULK_APPOINTMENT: &str = "bulk_appointment";
/// Intake reads use the same scoped personal-data administration permission as decisions.
pub const PRIVACY_REQUEST_INTAKE_READ: &str = "privacy_request_intake_read";

/// The platform schema: the node hierarchy, grants, accounts, one action group
/// per offered (domain, level) and one action per tagged operation key.
#[must_use]
pub fn schema_source() -> String {
    let mut src = String::from(
        "entity Tenant = { org: String };\n\
         entity LegalEntity in [Tenant] = { org: String };\n\
         entity Workplace in [LegalEntity] = { org: String };\n\
         entity Dept in [Workplace, Dept] = { org: String };\n\
         entity Grant;\n\
         entity Account in [Grant] = { org: String, is_ops: Bool };\n",
    );
    for domain in Domain::ALL {
        for level in domain.offered() {
            src.push_str(&format!(
                "action \"{}\" {APPLIES}\n",
                action_group(domain, *level)
            ));
        }
    }
    for (feature, domain, level) in tagged() {
        src.push_str(&format!(
            "action \"{}\" in [\"{}\"] {APPLIES}\n",
            feature.as_str(),
            action_group(domain, level)
        ));
    }
    src.push_str(&format!(
        "action \"{BULK_APPOINTMENT}\" in [\"{}\", \"{}\"] {APPLIES}\n\
         action \"{}\" in [\"{}\", \"{}\"] {APPLIES}\n\
         action \"{}\" in [\"{}\"] {APPLIES}\n",
        action_group(Domain::HrBasic, super::catalog::Level::Edit),
        action_group(Domain::Appointment, super::catalog::Level::Edit),
        crate::cedar_pbac::actions::certificates::SETTINGS_READ,
        action_group(Domain::HrBasic, super::catalog::Level::Edit),
        action_group(Domain::Org, super::catalog::Level::Edit),
        crate::cedar_pbac::actions::certificates::SETTINGS_MANAGE,
        action_group(Domain::Org, super::catalog::Level::Edit),
    ));
    src.push_str(&format!(
        "action \"{PRIVACY_REQUEST_INTAKE_READ}\" in [\"{}\"] {APPLIES}\n",
        action_group(Domain::HrBasic, super::catalog::Level::Edit),
    ));
    src.push_str(&format!(
        "action \"{GO_LIVE_RECEIPT_READ}\" in [\"{}\", \"{}\", \"{}\"] {APPLIES}\n",
        action_group(Domain::Org, super::catalog::Level::Edit),
        action_group(Domain::HrBasic, super::catalog::Level::Edit),
        action_group(Domain::Access, super::catalog::Level::Edit),
    ));
    src
}
