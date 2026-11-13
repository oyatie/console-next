//! What a grant line does NOT reach over a scope narrower than the tenant
//! (AX-5), as stable codes the screens word: every HR door decides per person
//! over the grant set, and these doors stay whole-tenant (a holder gets the
//! typed `scope_tenant_wide_only`). A tenant-wide grant has no caveat.

use console_platform_authz::access::{Domain, Level, NodeKind};

/// The caveat codes of one (domain, level) line over a `kind` scope.
#[must_use]
pub fn caveats(domain: Domain, level: Level, kind: NodeKind) -> Vec<&'static str> {
    if kind == NodeKind::Tenant {
        return Vec::new();
    }
    match (domain, level) {
        // Register, HR record cards and history: only people inside this scope.
        (Domain::HrBasic, Level::View) => vec!["scope_people"],
        // Registration only into this scope; register import, employee number rules and
        // bulk changes, bulk correction, same-person merge and change bundles: tenant-wide
        // access only.
        (Domain::HrBasic, Level::Edit) => vec!["scope_register", "tenant_wide_hr_basic"],
        (Domain::HrBasic, Level::Export) => vec!["scope_export"],
        // Issuing appointments to several people at once: tenant-wide access only.
        (Domain::Appointment, Level::Edit) => vec!["scope_people", "tenant_wide_bulk_appointment"],
        // Exit report and HR confirmation: people in scope; settlement and closing are
        // still by branch.
        (Domain::Exit, Level::Edit) => vec!["scope_people", "exit_settlement_branch"],
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tenant_grant_has_no_caveat_and_a_scoped_hr_edit_names_the_tenant_wide_doors() {
        assert!(caveats(Domain::HrBasic, Level::Edit, NodeKind::Tenant).is_empty());
        assert_eq!(
            caveats(Domain::HrBasic, Level::Edit, NodeKind::LegalEntity),
            ["scope_register", "tenant_wide_hr_basic"]
        );
        assert_eq!(
            caveats(Domain::Appointment, Level::Edit, NodeKind::Department),
            ["scope_people", "tenant_wide_bulk_appointment"]
        );
        assert!(caveats(Domain::Access, Level::Edit, NodeKind::Workplace).is_empty());
    }
}
