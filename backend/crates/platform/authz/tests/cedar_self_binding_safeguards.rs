// SPDX-License-Identifier: LicenseRef-Proprietary
use console_platform_authz::cedar_pbac::actions::{account_link_record, account_link_withdraw};

#[test]
fn only_matching_records_or_deliberate_no_match_confirmations_pass() {
    for matches_record in [false, true] {
        for any_match in [false, true] {
            for name_confirmed in [false, true] {
                let facts = account_link_record::Facts {
                    matches_record,
                    any_match,
                    name_confirmed,
                };
                assert_eq!(
                    account_link_record::decide("actor", "org", "org", facts),
                    Ok(matches_record || (!any_match && name_confirmed))
                );
                assert_eq!(
                    account_link_record::decide("actor", "org", "foreign", facts),
                    Ok(false)
                );
            }
        }
    }
}

#[test]
fn withdrawal_requires_the_self_attester_and_a_pending_binding() {
    for own in [false, true] {
        for pending in [false, true] {
            assert_eq!(
                account_link_withdraw::decide("actor", "org", "org", own, pending),
                Ok(own && pending)
            );
            assert_eq!(
                account_link_withdraw::decide("actor", "org", "foreign", own, pending),
                Ok(false)
            );
        }
    }
}
