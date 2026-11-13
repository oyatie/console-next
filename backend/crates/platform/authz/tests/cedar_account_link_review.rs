// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::cedar_pbac::actions::account_link_review::decide;

#[test]
fn review_requires_both_live_permission_and_independence_in_the_same_tenant() {
    for independent in [false, true] {
        for eligible in [false, true] {
            assert_eq!(
                decide("actor", "org", "org", independent, eligible),
                Ok(independent && eligible)
            );
            assert_eq!(
                decide("actor", "org", "foreign", independent, eligible),
                Ok(false)
            );
        }
    }
}
