// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::cedar_pbac::actions::account_link_solo::{Facts, decide};

const SOLO: Facts = Facts {
    subject_is_self: true,
    operator: true,
    unbound: true,
    holds_permission: true,
    other_holder: false,
};

#[test]
fn only_an_unbound_solo_operator_can_receive_the_offer() {
    assert_eq!(decide("actor", "org", "org", SOLO), Ok(true));
    for facts in [
        Facts {
            subject_is_self: false,
            ..SOLO
        },
        Facts {
            operator: false,
            ..SOLO
        },
        Facts {
            unbound: false,
            ..SOLO
        },
        Facts {
            holds_permission: false,
            ..SOLO
        },
        Facts {
            other_holder: true,
            ..SOLO
        },
    ] {
        assert_eq!(decide("actor", "org", "org", facts), Ok(false));
    }
    assert_eq!(decide("actor", "org", "other", SOLO), Ok(false));
}
