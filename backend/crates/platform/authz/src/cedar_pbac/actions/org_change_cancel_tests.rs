// SPDX-License-Identifier: LicenseRef-Proprietary
use super::*;

#[test]
fn withdrawal_is_owned_by_the_drafter_and_other_cancels_need_live_authority() {
    for holds_permission in [false, true] {
        for actor_is_drafter in [false, true] {
            for in_approval in [false, true] {
                let facts = Facts {
                    holds_permission,
                    actor_is_drafter,
                    in_approval,
                };
                assert_eq!(
                    enforce("u", "o", "o", facts).is_ok(),
                    if in_approval {
                        actor_is_drafter
                    } else {
                        holds_permission
                    }
                );
                assert!(enforce("u", "o", "foreign", facts).is_err());
                if in_approval && !actor_is_drafter && holds_permission {
                    assert_eq!(
                        enforce("u", "o", "o", facts).err().and_then(|e| e.code),
                        Some("org_change.refuse.not_drafter")
                    );
                }
            }
        }
    }
}

#[test]
fn missing_facts_fail_closed() {
    let bundle = ActionBundle::compile(ACTION, SCHEMA, POLICIES).unwrap();
    assert!(bundle.decide("u", "o", &[], "o", &[]).is_err());
    assert!(
        bundle
            .decide(
                "u",
                "o",
                &[],
                "o",
                &[
                    ("holds_permission", Fact::Bool(true)),
                    ("actor_is_drafter", Fact::Str("true".into())),
                    ("in_approval", Fact::Bool(true)),
                ]
            )
            .is_err()
    );
}
