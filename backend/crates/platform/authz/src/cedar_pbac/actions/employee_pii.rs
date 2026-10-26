// SPDX-License-Identifier: LicenseRef-Proprietary
//! SEC-01: separate reveal and record acts, using facts computed in the use-case transaction.
use super::{ActionBundle, Fact};
use std::sync::OnceLock;

const ACTION: &str = "employee_pii";
const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action employee_pii appliesTo {
  principal: [Subject], resource: [Resource],
  context: { "operation": String, "field": String, "actor_manages_directory": Bool,
    "subject_in_scope": Bool, "purpose_given": Bool, "step_up_verified": Bool, "within_rate": Bool }
};"#;
const POLICIES: &str = r#"permit (principal, action == Action::"employee_pii", resource)
when { principal.org == resource.org && context.actor_manages_directory
  && context.subject_in_scope && context.step_up_verified && context.within_rate
  && ((context.operation == "reveal" && context.purpose_given && ["RRN", "BIRTH_DATE", "ADDRESS", "PHONE", "PERSONAL_EMAIL"].contains(context.field))
    || (context.operation == "record" && context.field == "RRN")) };"#;

#[derive(Clone, Copy)]
pub struct PiiFacts<'a> {
    pub operation: &'a str,
    pub field: &'a str,
    pub actor_manages_directory: bool,
    pub subject_in_scope: bool,
    pub purpose_given: bool,
    pub step_up_verified: bool,
    pub within_rate: bool,
}

pub fn decide(principal: &str, org: &str, f: PiiFacts<'_>) -> Result<bool, String> {
    static BUNDLE: OnceLock<Result<ActionBundle, String>> = OnceLock::new();
    let bundle = BUNDLE
        .get_or_init(|| ActionBundle::compile(ACTION, SCHEMA, POLICIES))
        .as_ref()
        .map_err(Clone::clone)?;
    bundle.decide(
        principal,
        org,
        &[],
        org,
        &[
            ("operation", Fact::Str(f.operation.into())),
            ("field", Fact::Str(f.field.into())),
            (
                "actor_manages_directory",
                Fact::Bool(f.actor_manages_directory),
            ),
            ("purpose_given", Fact::Bool(f.purpose_given)),
            ("subject_in_scope", Fact::Bool(f.subject_in_scope)),
            ("step_up_verified", Fact::Bool(f.step_up_verified)),
            ("within_rate", Fact::Bool(f.within_rate)),
        ],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_fact_is_required_and_unknown_acts_fail_closed() {
        let yes = PiiFacts {
            operation: "reveal",
            field: "RRN",
            actor_manages_directory: true,
            subject_in_scope: true,
            purpose_given: true,
            step_up_verified: true,
            within_rate: true,
        };
        assert_eq!(decide("u", "o", yes), Ok(true));
        for no in [
            PiiFacts {
                subject_in_scope: false,
                ..yes
            },
            PiiFacts {
                actor_manages_directory: false,
                ..yes
            },
            PiiFacts {
                purpose_given: false,
                ..yes
            },
            PiiFacts {
                step_up_verified: false,
                ..yes
            },
            PiiFacts {
                within_rate: false,
                ..yes
            },
            PiiFacts {
                field: "OTHER",
                ..yes
            },
            PiiFacts {
                operation: "export",
                ..yes
            },
        ] {
            assert_eq!(decide("u", "o", no), Ok(false));
        }
    }
}
