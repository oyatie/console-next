// SPDX-License-Identifier: LicenseRef-Proprietary
//! Approval reads use source relationships, never an administrator bypass.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action approval_document_list appliesTo { principal: [Subject], resource: [Resource],
 context: { "read": Bool, "requester": Bool, "participant": Bool,
            "can_review": Bool, "completed": Bool, "box": String }
};"#;
const POLICIES: &str = r#"permit(principal, action == Action::"approval_document_list", resource)
when { principal.org == resource.org && context.read && (
 (context.box == "pending" && !context.completed && context.can_review && !context.requester && !context.participant) ||
 (context.box == "requested" && !context.completed && context.requester) ||
 (context.box == "completed" && context.completed && (context.requester || context.participant))
) };"#;
#[derive(Clone, Copy)]
pub struct Facts {
    pub read: bool,
    pub requester: bool,
    pub participant: bool,
    pub can_review: bool,
    pub completed: bool,
}
pub fn decide(
    actor: &str,
    org: &str,
    resource_org: &str,
    f: Facts,
    box_name: &str,
) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile("approval_document_list", SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?
        .decide(
            actor,
            org,
            &[],
            resource_org,
            &[
                ("read", Fact::Bool(f.read)),
                ("requester", Fact::Bool(f.requester)),
                ("participant", Fact::Bool(f.participant)),
                ("can_review", Fact::Bool(f.can_review)),
                ("completed", Fact::Bool(f.completed)),
                ("box", Fact::Str(box_name.into())),
            ],
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tenant_relationship_and_complete_typed_facts_are_required() {
        let f = Facts {
            read: true,
            requester: false,
            participant: false,
            can_review: false,
            completed: false,
        };
        for box_name in ["pending", "upcoming", "requested", "reference", "completed"] {
            assert_eq!(decide("u", "o", "o", f, box_name), Ok(false));
            assert_eq!(
                decide(
                    "u",
                    "o",
                    "other",
                    Facts {
                        requester: true,
                        can_review: true,
                        ..f
                    },
                    box_name
                ),
                Ok(false)
            );
        }
        assert_eq!(
            decide(
                "u",
                "o",
                "o",
                Facts {
                    requester: true,
                    ..f
                },
                "requested"
            ),
            Ok(true)
        );
        assert_eq!(
            decide(
                "u",
                "o",
                "o",
                Facts {
                    can_review: true,
                    ..f
                },
                "pending"
            ),
            Ok(true)
        );
        assert_eq!(
            decide(
                "u",
                "o",
                "o",
                Facts {
                    can_review: true,
                    read: false,
                    ..f
                },
                "pending"
            ),
            Ok(false)
        );
        for (requester, participant) in [(true, false), (false, true)] {
            assert_eq!(
                decide(
                    "u",
                    "o",
                    "o",
                    Facts {
                        can_review: true,
                        requester,
                        participant,
                        ..f
                    },
                    "pending"
                ),
                Ok(false)
            );
        }
        let bundle = ActionBundle::compile("approval_document_list", SCHEMA, POLICIES).unwrap();
        assert!(bundle.decide("u", "o", &[], "o", &[]).is_err());
        assert!(
            bundle
                .decide("u", "o", &[], "o", &[("read", Fact::Str("true".into()))])
                .is_err()
        );
    }
}
