// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::cedar_pbac::actions::org_change_sole_holder::{Facts, decide};

fn sole() -> Facts {
    Facts {
        holds_permission: true,
        identities_bound: true,
        requires_exception: true,
        routed: true,
        pending: true,
        other_holder: false,
        sole_holder_allowed: true,
    }
}

#[test]
fn every_case_b_condition_is_required() {
    assert_eq!(decide("a", "o", "o", sole()), Ok(true));
    for change in [
        |f: &mut Facts| f.holds_permission = false,
        |f: &mut Facts| f.identities_bound = false,
        |f: &mut Facts| f.requires_exception = false,
        |f: &mut Facts| f.routed = false,
        |f: &mut Facts| f.pending = false,
        |f: &mut Facts| f.other_holder = true,
        |f: &mut Facts| f.sole_holder_allowed = false,
    ] {
        let mut f = sole();
        change(&mut f);
        assert_eq!(decide("a", "o", "o", f), Ok(false));
    }
}

#[test]
fn foreign_tenant_denies_case_b() {
    assert_eq!(decide("a", "o", "foreign", sole()), Ok(false));
}
