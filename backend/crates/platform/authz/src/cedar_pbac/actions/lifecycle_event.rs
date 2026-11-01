// SPDX-License-Identifier: LicenseRef-Proprietary
//! Read-time offers and command guards share Cedar's correction/rescission rules.
use std::sync::OnceLock;

use super::{ActionBundle, Fact};

pub const CORRECT: &str = "lifecycle_event_correct";
pub const RESCIND: &str = "lifecycle_event_rescind";
pub const ACTIONS: [&str; 2] = [CORRECT, RESCIND];
const CODES: [&str; 5] = [
    "lifecycle_void_not_applied",
    "lifecycle_void_exit_owned",
    "lifecycle_void_unsupported",
    "lifecycle_event_voided",
    "lifecycle_void_not_latest",
];

pub struct EventFacts<'a> {
    pub holds_permission: bool,
    pub state: &'a str,
    pub kind: &'a str,
    pub voided: bool,
    pub latest: bool,
}

fn bundles() -> Result<&'static [ActionBundle], String> {
    static BUNDLES: OnceLock<Result<Vec<ActionBundle>, String>> = OnceLock::new();
    BUNDLES.get_or_init(|| ACTIONS.iter().map(|&action| {
        let schema = format!(r#"entity Subject = {{ "org": String, "roles": Set<String> }};
entity Resource = {{ "org": String }};
action {action} appliesTo {{ principal: [Subject], resource: [Resource], context: {{
  "holds_permission": Bool, "state": String, "kind": String, "voided": Bool, "latest": Bool
}} }};"#);
        let correcting = action == ACTIONS[0];
        let policies = format!(r#"permit(principal, action == Action::"{action}", resource)
when {{ principal.org == resource.org && context.holds_permission }};
@reason("lifecycle_void_not_applied")
forbid(principal, action == Action::"{action}", resource) when {{ context.state != "APPLIED" }};
@reason("lifecycle_void_exit_owned")
forbid(principal, action == Action::"{action}", resource) when {{ ["TERMINATE", "OFFBOARD", "EXIT_REVERSAL"].contains(context.kind) }};
@reason("lifecycle_void_unsupported")
forbid(principal, action == Action::"{action}", resource) when {{ ["ONBOARD", "REHIRE", "RESCIND"].contains(context.kind)
  || ({correcting} && context.kind == "GROUP_TRANSFER" && !context.voided && context.latest) }};
@reason("lifecycle_event_voided")
forbid(principal, action == Action::"{action}", resource) when {{ context.voided }};
@reason("lifecycle_void_not_latest")
forbid(principal, action == Action::"{action}", resource) when {{ !context.latest }};"#);
        ActionBundle::compile(action, &schema, &policies)
    }).collect()).as_ref().map(Vec::as_slice).map_err(Clone::clone)
}

/// A missing permission, foreign tenant or Cedar error fails closed.
pub fn refusal(
    action: &str,
    actor: &str,
    org: &str,
    resource_org: &str,
    f: &EventFacts<'_>,
) -> Result<Option<&'static str>, String> {
    let index = ACTIONS
        .iter()
        .position(|a| *a == action)
        .ok_or("unknown lifecycle event action")?;
    let (allowed, reasons) = bundles()?[index].decide_with_reasons(
        actor,
        org,
        &[],
        resource_org,
        &[
            ("holds_permission", Fact::Bool(f.holds_permission)),
            ("state", Fact::Str(f.state.to_owned())),
            ("kind", Fact::Str(f.kind.to_owned())),
            ("voided", Fact::Bool(f.voided)),
            ("latest", Fact::Bool(f.latest)),
        ],
    )?;
    Ok(if allowed {
        None
    } else if !f.holds_permission || org != resource_org {
        Some("forbidden")
    } else {
        Some(
            CODES
                .into_iter()
                .find(|code| reasons.iter().any(|r| r == code))
                .unwrap_or("forbidden"),
        )
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    #[test]
    fn both_actions_enforce_every_refusal_and_tenant_permission_floor() {
        for action in ACTIONS {
            let base = EventFacts {
                holds_permission: true,
                state: "APPLIED",
                kind: "TRANSFER",
                voided: false,
                latest: true,
            };
            let decide = |f: &EventFacts<'_>| refusal(action, "u", "o", "o", f).unwrap();
            assert_eq!(decide(&base), None);
            for (facts, code) in [
                (
                    EventFacts {
                        state: "SCHEDULED",
                        ..base
                    },
                    "lifecycle_void_not_applied",
                ),
                (
                    EventFacts {
                        kind: "TERMINATE",
                        ..base
                    },
                    "lifecycle_void_exit_owned",
                ),
                (
                    EventFacts {
                        kind: "ONBOARD",
                        ..base
                    },
                    "lifecycle_void_unsupported",
                ),
                (
                    EventFacts {
                        voided: true,
                        latest: false,
                        ..base
                    },
                    "lifecycle_event_voided",
                ),
                (
                    EventFacts {
                        latest: false,
                        ..base
                    },
                    "lifecycle_void_not_latest",
                ),
                (
                    EventFacts {
                        holds_permission: false,
                        ..base
                    },
                    "forbidden",
                ),
            ] {
                assert_eq!(decide(&facts), Some(code));
            }
            assert_eq!(
                refusal(action, "u", "o", "other", &base).unwrap(),
                Some("forbidden")
            );
            let group = EventFacts {
                kind: "GROUP_TRANSFER",
                ..base
            };
            assert_eq!(
                decide(&EventFacts {
                    voided: true,
                    ..group
                }),
                Some("lifecycle_event_voided")
            );
            assert_eq!(
                decide(&EventFacts {
                    latest: false,
                    ..group
                }),
                Some("lifecycle_void_not_latest")
            );
            assert_eq!(
                decide(&group),
                if action == ACTIONS[0] {
                    Some("lifecycle_void_unsupported")
                } else {
                    None
                }
            );
        }
    }

    #[test]
    fn missing_mistyped_facts_and_unknown_actions_fail_closed() {
        for bundle in bundles().unwrap() {
            assert!(bundle.decide("u", "o", &[], "o", &[]).is_err());
            assert!(
                bundle
                    .decide(
                        "u",
                        "o",
                        &[],
                        "o",
                        &[("holds_permission", Fact::Str("true".into()))]
                    )
                    .is_err()
            );
        }
        let f = EventFacts {
            holds_permission: true,
            state: "APPLIED",
            kind: "TRANSFER",
            voided: false,
            latest: true,
        };
        assert!(refusal("unknown", "u", "o", "o", &f).is_err());
    }
}
