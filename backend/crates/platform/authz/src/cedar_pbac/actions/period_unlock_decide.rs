//! Who decides a waiting period unlock (BW-15; decisions D0.2, #26 item d):
//! another natural person than the requester (`independent`, from the
//! `independent_people` bindings), who is an eligible second person
//! (`eligible`, identity's D0.2 fact over every live, aged, noticed grant).
//! The use case computes the facts inside its decision transaction.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "period_unlock_decide";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action period_unlock_decide appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "independent": Bool, "eligible": Bool }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"period_unlock_decide", resource)
when { principal.org == resource.org && context.independent && context.eligible };"#;

fn bundle() -> Result<&'static ActionBundle, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)
}

/// The decision facts of one decider.
#[derive(Debug, Clone, Copy)]
pub struct DecideFacts {
    pub independent: bool,
    pub eligible: bool,
}

/// Whether `user` of `org` may decide an unlock of `lock_org`. Compilation or
/// evaluation diagnostics are a refusal.
#[must_use]
pub fn decide(user: &str, org: &str, lock_org: &str, f: DecideFacts) -> bool {
    bundle()
        .and_then(|b| {
            b.decide(
                user,
                org,
                &[],
                lock_org,
                &[
                    ("independent", Fact::Bool(f.independent)),
                    ("eligible", Fact::Bool(f.eligible)),
                ],
            )
        })
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    const fn f(independent: bool, eligible: bool) -> DecideFacts {
        DecideFacts {
            independent,
            eligible,
        }
    }

    /// Neither missing independence nor missing eligibility admits a decision.
    #[test]
    fn only_an_independent_eligible_person_decides() {
        assert!(decide("u", "o", "o", f(true, true)));
        assert!(!decide("u", "o", "o", f(true, false)));
        assert!(
            !decide("u", "o", "o", f(false, true)),
            "never the requester's own person"
        );
        assert!(!decide("u", "o", "foreign", f(true, true)));
        assert!(bundle().unwrap().decide("u", "o", &[], "o", &[]).is_err());
    }
}
