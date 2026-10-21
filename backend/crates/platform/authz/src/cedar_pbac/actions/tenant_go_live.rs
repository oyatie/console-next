//! `tenant_go_live` (운영 시작): the one-way SETUP → OPERATING transition
//! (entity-depth design §5.4). The onboarding adapter computes every fact in
//! the go-live transaction under `FOR UPDATE` on `tenant_phase`; the Rust
//! backstop checks the same facts, and the transition needs BOTH to allow.

use std::sync::OnceLock;

use super::{ActionBundle, Fact};

pub const ACTION: &str = "tenant_go_live";
pub const SCHEMA_VERSION: &str = "2026-10-tenant-go-live-v2";

pub const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action tenant_go_live appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: {
    "phase": String,
    "step_up": Bool,
    "entities_ready": Bool,
    "primary_workplaces_ready": Bool,
    "org_change_route_resolvable": Bool,
    "org_change_routed": Bool,
    "other_eligible_holders": Long,
    "sole_holder_acknowledged": Bool,
    "security_contact_recorded": Bool,
    "security_contact_store_available": Bool,
    "terms_accepted": Bool,
    "preview_digest_matches": Bool
  }
};
"#;

pub const POLICIES: &str = r#"permit (principal, action == Action::"tenant_go_live", resource)
when {
  principal.roles.contains("SUPER_ADMIN") && principal.org == resource.org
  && context.step_up && context.phase == "SETUP"
  && context.entities_ready && context.primary_workplaces_ready
  && context.org_change_route_resolvable
  && (!context.org_change_routed || context.other_eligible_holders > 0
      || context.sole_holder_acknowledged)
  && (context.security_contact_recorded || !context.security_contact_store_available)
  && context.terms_accepted && context.preview_digest_matches
};
forbid (principal, action == Action::"tenant_go_live", resource)
when { context.phase != "SETUP" };
"#;

/// Server-computed facts (D0.1.4). Never taken from the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GoLiveFacts {
    pub phase_is_setup: bool,
    pub step_up: bool,
    pub entities_ready: bool,
    pub primary_workplaces_ready: bool,
    pub org_change_route_resolvable: bool,
    /// `approval.policy.org_structure = route` (decisions #26): only then is
    /// a sole holder's acknowledgement asked for.
    pub org_change_routed: bool,
    pub other_eligible_holders: i64,
    pub sole_holder_acknowledged: bool,
    pub security_contact_recorded: bool,
    pub security_contact_store_available: bool,
    pub terms_accepted: bool,
    pub preview_digest_matches: bool,
}

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

/// Cedar's answer. Any compile or evaluation error is a deny (`Err`).
///
/// # Errors
/// The Cedar diagnostics when the decision could not be made cleanly.
pub fn decide(principal: &str, org: &str, roles: &[&str], f: GoLiveFacts) -> Result<bool, String> {
    let facts = [
        (
            "phase",
            Fact::Str(
                if f.phase_is_setup {
                    "SETUP"
                } else {
                    "OPERATING"
                }
                .to_owned(),
            ),
        ),
        ("step_up", Fact::Bool(f.step_up)),
        ("entities_ready", Fact::Bool(f.entities_ready)),
        (
            "primary_workplaces_ready",
            Fact::Bool(f.primary_workplaces_ready),
        ),
        (
            "org_change_route_resolvable",
            Fact::Bool(f.org_change_route_resolvable),
        ),
        ("org_change_routed", Fact::Bool(f.org_change_routed)),
        (
            "other_eligible_holders",
            Fact::Long(f.other_eligible_holders),
        ),
        (
            "sole_holder_acknowledged",
            Fact::Bool(f.sole_holder_acknowledged),
        ),
        (
            "security_contact_recorded",
            Fact::Bool(f.security_contact_recorded),
        ),
        (
            "security_contact_store_available",
            Fact::Bool(f.security_contact_store_available),
        ),
        ("terms_accepted", Fact::Bool(f.terms_accepted)),
        (
            "preview_digest_matches",
            Fact::Bool(f.preview_digest_matches),
        ),
    ];
    bundle()?.decide(principal, org, roles, org, &facts)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_TRUE: GoLiveFacts = GoLiveFacts {
        phase_is_setup: true,
        step_up: true,
        entities_ready: true,
        primary_workplaces_ready: true,
        org_change_route_resolvable: true,
        org_change_routed: true,
        other_eligible_holders: 0,
        sole_holder_acknowledged: true,
        security_contact_recorded: false,
        security_contact_store_available: false,
        terms_accepted: true,
        preview_digest_matches: true,
    };

    #[test]
    fn compiles_strictly_and_permits_a_ready_solo_super_admin() {
        assert_eq!(decide("u", "o", &["SUPER_ADMIN"], ALL_TRUE), Ok(true));
        assert_eq!(decide("u", "o", &["EXECUTIVE"], ALL_TRUE), Ok(false));
    }

    #[test]
    fn every_fact_is_load_bearing() {
        let flips: [fn(&mut GoLiveFacts); 9] = [
            |f| f.phase_is_setup = false,
            |f| f.step_up = false,
            |f| f.entities_ready = false,
            |f| f.primary_workplaces_ready = false,
            |f| f.org_change_route_resolvable = false,
            |f| f.sole_holder_acknowledged = false,
            |f| f.security_contact_store_available = true,
            |f| f.terms_accepted = false,
            |f| f.preview_digest_matches = false,
        ];
        for flip in flips {
            let mut facts = ALL_TRUE;
            flip(&mut facts);
            assert_eq!(
                decide("u", "o", &["SUPER_ADMIN"], facts),
                Ok(false),
                "{facts:?}"
            );
        }
        let with_second = GoLiveFacts {
            sole_holder_acknowledged: false,
            other_eligible_holders: 1,
            ..ALL_TRUE
        };
        assert_eq!(decide("u", "o", &["SUPER_ADMIN"], with_second), Ok(true));
    }

    /// decisions #26: under `approval.policy.org_structure = none` a solo
    /// tenant goes live without the sole-holder tick; under `route` the
    /// missing tick keeps refusing.
    #[test]
    fn regression_w10_the_sole_holder_tick_binds_only_under_route() {
        let unticked = GoLiveFacts {
            sole_holder_acknowledged: false,
            ..ALL_TRUE
        };
        assert_eq!(decide("u", "o", &["SUPER_ADMIN"], unticked), Ok(false));
        let none = GoLiveFacts {
            org_change_routed: false,
            ..unticked
        };
        assert_eq!(decide("u", "o", &["SUPER_ADMIN"], none), Ok(true));
    }

    #[test]
    fn missing_fact_is_refused_before_evaluation() {
        let bundle = bundle().unwrap();
        let partial = [("phase", Fact::Str("SETUP".into()))];
        assert!(
            bundle
                .decide("u", "o", &["SUPER_ADMIN"], "o", &partial)
                .is_err()
        );
    }
}
