// SPDX-License-Identifier: LicenseRef-Proprietary
//! Platform operator management policies (list, invite, reissue, revoke).

use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action platform_operator_list, platform_operator_invite, platform_operator_reissue, platform_operator_revoke appliesTo {
  principal: [Subject], resource: [Resource],
  context: {
    "platform": Bool,
    "active": Bool,
    "step_up": Bool,
    "has_passkey": Bool,
    "actor_is_target": Bool,
    "other_active_enrolled": Long
  }
};"#;

const POLICIES: &str = r#"permit(principal, action == Action::"platform_operator_list", resource)
when {
  principal.org == resource.org
  && principal.roles.contains("SUPER_ADMIN")
  && context.platform
  && context.active
};

permit(principal, action == Action::"platform_operator_invite", resource)
when {
  principal.org == resource.org
  && principal.roles.contains("SUPER_ADMIN")
  && context.platform
  && context.active
  && context.step_up
  && context.has_passkey
};

permit(principal, action == Action::"platform_operator_reissue", resource)
when {
  principal.org == resource.org
  && principal.roles.contains("SUPER_ADMIN")
  && context.platform
  && context.active
  && context.step_up
  && context.has_passkey
};

permit(principal, action == Action::"platform_operator_revoke", resource)
when {
  principal.org == resource.org
  && principal.roles.contains("SUPER_ADMIN")
  && context.platform
  && context.active
  && context.step_up
  && context.has_passkey
};

@reason("cannot_revoke_self")
forbid(principal, action == Action::"platform_operator_revoke", resource)
when { context.actor_is_target };

@reason("last_platform_operator")
forbid(principal, action == Action::"platform_operator_revoke", resource)
when { context.other_active_enrolled <= 0 };"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    List,
    Invite,
    Reissue,
    Revoke,
}

#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub platform: bool,
    pub active: bool,
    pub step_up: bool,
    pub has_passkey: bool,
    pub actor_is_target: bool,
    pub other_active_enrolled: i64,
}

fn bundle(action: Action) -> Result<&'static ActionBundle, String> {
    static LIST: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    static INVITE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    static REISSUE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    static REVOKE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let (cached, name) = match action {
        Action::List => (&LIST, "platform_operator_list"),
        Action::Invite => (&INVITE, "platform_operator_invite"),
        Action::Reissue => (&REISSUE, "platform_operator_reissue"),
        Action::Revoke => (&REVOKE, "platform_operator_revoke"),
    };
    cached
        .get_or_init(|| ActionBundle::compile(name, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

#[must_use]
pub fn decide(
    action: Action,
    user: &str,
    actor_org: &str,
    target_org: &str,
    roles: &[&str],
    facts: Facts,
) -> (bool, Vec<String>) {
    bundle(action)
        .and_then(|b| {
            b.decide_with_reasons(
                user,
                actor_org,
                roles,
                target_org,
                &[
                    ("platform", Fact::Bool(facts.platform)),
                    ("active", Fact::Bool(facts.active)),
                    ("step_up", Fact::Bool(facts.step_up)),
                    ("has_passkey", Fact::Bool(facts.has_passkey)),
                    ("actor_is_target", Fact::Bool(facts.actor_is_target)),
                    (
                        "other_active_enrolled",
                        Fact::Long(facts.other_active_enrolled),
                    ),
                ],
            )
        })
        .unwrap_or_else(|_| (false, Vec::new()))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::expect_used)]

    use super::*;

    const fn base_facts() -> Facts {
        Facts {
            platform: true,
            active: true,
            step_up: true,
            has_passkey: true,
            actor_is_target: false,
            other_active_enrolled: 1,
        }
    }

    #[test]
    fn list_requires_active_platform_super_admin() {
        let f = base_facts();
        assert!(
            decide(
                Action::List,
                "a",
                "platform",
                "platform",
                &["SUPER_ADMIN"],
                f
            )
            .0
        );
        assert!(!decide(Action::List, "a", "platform", "platform", &["ADMIN"], f).0);
        assert!(!decide(Action::List, "a", "tenant", "platform", &["SUPER_ADMIN"], f).0);
        assert!(
            !decide(
                Action::List,
                "a",
                "platform",
                "platform",
                &["SUPER_ADMIN"],
                Facts {
                    platform: false,
                    ..f
                }
            )
            .0
        );
        assert!(
            !decide(
                Action::List,
                "a",
                "platform",
                "platform",
                &["SUPER_ADMIN"],
                Facts { active: false, ..f }
            )
            .0
        );
    }

    #[test]
    fn invite_and_reissue_require_step_up_and_passkey() {
        let f = base_facts();
        for action in [Action::Invite, Action::Reissue] {
            assert!(decide(action, "a", "platform", "platform", &["SUPER_ADMIN"], f).0);
            assert!(
                !decide(
                    action,
                    "a",
                    "platform",
                    "platform",
                    &["SUPER_ADMIN"],
                    Facts {
                        step_up: false,
                        ..f
                    }
                )
                .0
            );
            assert!(
                !decide(
                    action,
                    "a",
                    "platform",
                    "platform",
                    &["SUPER_ADMIN"],
                    Facts {
                        has_passkey: false,
                        ..f
                    }
                )
                .0
            );
            assert!(!decide(action, "a", "platform", "platform", &["ADMIN"], f).0);
        }
    }

    #[test]
    fn revoke_enforces_anti_self_and_anti_last_operator() {
        let f = base_facts();
        assert!(
            decide(
                Action::Revoke,
                "a",
                "platform",
                "platform",
                &["SUPER_ADMIN"],
                f
            )
            .0
        );

        let (allowed, reasons) = decide(
            Action::Revoke,
            "a",
            "platform",
            "platform",
            &["SUPER_ADMIN"],
            Facts {
                actor_is_target: true,
                ..f
            },
        );
        assert!(!allowed);
        assert!(reasons.iter().any(|r| r == "cannot_revoke_self"));

        let (allowed, reasons) = decide(
            Action::Revoke,
            "a",
            "platform",
            "platform",
            &["SUPER_ADMIN"],
            Facts {
                other_active_enrolled: 0,
                ..f
            },
        );
        assert!(!allowed);
        assert!(reasons.iter().any(|r| r == "last_platform_operator"));

        assert!(
            !decide(
                Action::Revoke,
                "a",
                "platform",
                "platform",
                &["SUPER_ADMIN"],
                Facts {
                    step_up: false,
                    ..f
                }
            )
            .0
        );
    }

    #[test]
    fn invalid_bundle_and_missing_facts_fail_closed() {
        assert!(ActionBundle::compile("platform_operator_list", SCHEMA, "invalid").is_err());
        for action in [
            Action::List,
            Action::Invite,
            Action::Reissue,
            Action::Revoke,
        ] {
            let b = bundle(action).expect("valid platform_operator policy bundle");
            assert!(
                b.decide("a", "platform", &["SUPER_ADMIN"], "platform", &[])
                    .is_err()
            );
        }
    }
}
