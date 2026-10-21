//! `own_record`: an HR write whose subject is the actor's own employee record
//! (people-self-33). The platform rule the role editor states 「본인 건 제외 ·
//! 어떤 역할로도 자기 자신의 인사 기록은 바꿀 수 없습니다」: nobody reports,
//! confirms, withdraws, appoints, corrects or renumbers their own record,
//! whatever they hold. Another holder in scope, or the ops account, records it.
//!
//! The one exception is the tenant ops account (break-glass, decision #26)
//! when no other account holds the act over the subject (#7 sole-holder path):
//! a solo admin's own exit must not dead-end. The caller logs that pass with a
//! review flag. The HR door has already decided the act itself; this action
//! only overlays the self rule, so it permits within the tenant and forbids.
//!
//! Every fact is computed by the HR adapter in the write's transaction.

use std::sync::OnceLock;

use super::{ActionBundle, Fact};

pub const ACTION: &str = "own_record";
pub const SCHEMA_VERSION: &str = "2026-10-own-record-v1";

pub const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action own_record appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: {
    "subject_is_self": Bool,
    "actor_is_ops": Bool,
    "other_eligible_holders": Long
  }
};
"#;

pub const POLICIES: &str = r#"permit (principal, action == Action::"own_record", resource)
when { principal.org == resource.org };
@reason("own_record_forbidden")
forbid (principal, action == Action::"own_record", resource)
when { context.subject_is_self }
unless { context.actor_is_ops && context.other_eligible_holders == 0 };
"#;

/// Server-computed facts. Never taken from the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OwnRecordFacts {
    /// The subject is the actor's linked employee, or the same natural person.
    pub subject_is_self: bool,
    /// The actor is the tenant's active ops account.
    pub actor_is_ops: bool,
    /// Other active accounts that hold the act over the subject.
    pub other_eligible_holders: i64,
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
pub fn decide(principal: &str, org: &str, f: OwnRecordFacts) -> Result<bool, String> {
    let facts = [
        ("subject_is_self", Fact::Bool(f.subject_is_self)),
        ("actor_is_ops", Fact::Bool(f.actor_is_ops)),
        (
            "other_eligible_holders",
            Fact::Long(f.other_eligible_holders),
        ),
    ];
    bundle()?.decide(principal, org, &[], org, &facts)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const OTHER: OwnRecordFacts = OwnRecordFacts {
        subject_is_self: false,
        actor_is_ops: false,
        other_eligible_holders: 0,
    };

    #[test]
    fn compiles_strictly_and_permits_a_record_that_is_not_ones_own() {
        assert_eq!(decide("u", "o", OTHER), Ok(true));
    }

    #[test]
    fn ones_own_record_is_refused_whatever_else_holds() {
        for holders in [0, 1, 5] {
            let own = OwnRecordFacts {
                subject_is_self: true,
                other_eligible_holders: holders,
                ..OTHER
            };
            assert_eq!(decide("u", "o", own), Ok(false), "{own:?}");
        }
    }

    #[test]
    fn ops_passes_only_as_the_sole_holder() {
        let ops = OwnRecordFacts {
            subject_is_self: true,
            actor_is_ops: true,
            other_eligible_holders: 0,
        };
        assert_eq!(decide("u", "o", ops), Ok(true));
        let others = OwnRecordFacts {
            other_eligible_holders: 1,
            ..ops
        };
        assert_eq!(decide("u", "o", others), Ok(false));
    }

    #[test]
    fn missing_facts_and_a_foreign_tenant_are_refused() {
        let bundle = bundle().unwrap();
        let partial = [("subject_is_self", Fact::Bool(false))];
        assert!(bundle.decide("u", "o", &[], "o", &partial).is_err());
        let full = [
            ("subject_is_self", Fact::Bool(false)),
            ("actor_is_ops", Fact::Bool(false)),
            ("other_eligible_holders", Fact::Long(0)),
        ];
        assert_eq!(bundle.decide("u", "o", &[], "other", &full), Ok(false));
    }
}
