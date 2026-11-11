// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used)]
use console_action_inbox_application::decision::{DecisionFacts, DecisionPolicy};
use console_settings_domain::SettingKey;

#[test]
fn only_routed_items_expose_policy_and_preserve_resolved_flags() {
    for routed in [false, true] {
        for bulk in [false, true] {
            for step_up in [false, true] {
                let facts = DecisionFacts::new(
                    "opaque".into(),
                    DecisionPolicy::routed(
                        SettingKey::ApprovalPolicyOrgStructure,
                        routed,
                        bulk,
                        step_up,
                    ),
                    Ok(()),
                );
                let row = serde_json::to_value(&facts).unwrap();
                assert_eq!(row["version"], "opaque");
                assert_eq!(row["can_decide"], true);
                assert!(row.get("cannot_reason").is_none());
                assert_eq!(row.get("policy").is_some(), routed);
                if routed {
                    assert_eq!(row["policy"]["key"], "approval.policy.org_structure");
                    assert_eq!(row["policy"]["routed"], true);
                    assert_eq!(row["policy"]["merge_consecutive"], false);
                    assert_eq!(row["policy"]["bulk_allowed"], bulk);
                    assert_eq!(row["policy"]["step_up"], step_up);
                }
            }
        }
    }
    for code in [None, Some("org_change_sod_violation")] {
        let mut refusal = console_kernel_core::KernelError::forbidden("refused");
        refusal.code = code;
        let row =
            serde_json::to_value(DecisionFacts::new("opaque".into(), None, Err(refusal))).unwrap();
        assert_eq!(row["can_decide"], false);
        assert_eq!(row["cannot_reason"], code.unwrap_or("forbidden"));
    }
}

#[test]
fn stored_chain_preserves_policy_independently_of_live_routing() {
    for routed in [false, true] {
        for has_steps in [false, true] {
            for enabled in [false, true] {
                let policy = DecisionPolicy::new(
                    SettingKey::ApprovalPolicyOrgStructure,
                    routed,
                    enabled,
                    enabled,
                );
                let governing = policy.for_stored_steps(has_steps);
                assert_eq!(governing.is_some(), has_steps);
                if let Some(governing) = governing {
                    assert!(governing.routed);
                    assert_eq!(governing.bulk_allowed, enabled);
                    assert_eq!(governing.step_up, enabled);
                    assert!(!governing.merge_consecutive);
                }
            }
        }
    }
}
