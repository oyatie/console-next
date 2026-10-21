//! `employee_restricted_record`: read, write or void a restricted 인사카드
//! entry (징계, 장애, 보훈; EMP-RECORD MR-33/35). 장애 is 건강 information,
//! 민감정보 under 개인정보 보호법 §23①; knowing a record exists is itself
//! sensitive (access-model §6.3 item 9), so every read names a purpose.
//!
//! The HR adapter computes every fact in the use-case transaction. No policy
//! reads `principal.roles` (no preset roles, no title-implied access): the
//! holder fact is the org-wide 인사기본 manage permission until the access
//! model's 건강·민감 domain grant exists.
//!
//! holder = `employee_directory_manage` org-wide (A2-15 wants a
//! separate 건강·민감 grant); add an `actor_holds_sensitive` fact when the
//! access-model domain catalog lands.

use std::sync::OnceLock;

use super::{ActionBundle, Fact};

pub const ACTION: &str = "employee_restricted_record";
pub const SCHEMA_VERSION: &str = "2026-10-emp-record-restricted-v1";

pub const SCHEMA: &str = r#"entity Subject = { "org": String, "roles": Set<String> };
entity Resource = { "org": String };
action employee_restricted_record appliesTo {
  principal: [Subject],
  resource: [Resource],
  context: {
    "operation": String,
    "actor_manages_directory": Bool,
    "subject_is_self": Bool,
    "section_enabled": Bool,
    "purpose_given": Bool
  }
};
"#;

pub const POLICIES: &str = r#"permit (principal, action == Action::"employee_restricted_record", resource)
when {
  principal.org == resource.org && context.actor_manages_directory
  && (context.operation != "read" || context.purpose_given)
  && (context.operation != "write" || context.section_enabled)
};
@reason("record_restricted_self")
forbid (principal, action == Action::"employee_restricted_record", resource)
when { context.subject_is_self };
forbid (principal, action == Action::"employee_restricted_record", resource)
unless { ["read", "write", "void"].contains(context.operation) };
"#;

/// What the actor asks to do. A void retires data, so it stays open with the
/// section switched off (as for every 인사카드 section).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Operation {
    Read,
    Write,
    Void,
}

impl Operation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Void => "void",
        }
    }
}

/// Server-computed facts. Never taken from the client.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RestrictedRecordFacts {
    pub operation: Operation,
    /// The actor holds org-wide `employee_directory_manage`.
    pub actor_manages_directory: bool,
    /// The record is the actor's own (account ↔ employee link, GR-20).
    pub subject_is_self: bool,
    /// The section's tenant switch is on now.
    pub section_enabled: bool,
    /// A valid `restricted_record_purpose` code was given.
    pub purpose_given: bool,
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
pub fn decide(principal: &str, org: &str, f: RestrictedRecordFacts) -> Result<bool, String> {
    let facts = [
        ("operation", Fact::Str(f.operation.as_str().to_owned())),
        (
            "actor_manages_directory",
            Fact::Bool(f.actor_manages_directory),
        ),
        ("subject_is_self", Fact::Bool(f.subject_is_self)),
        ("section_enabled", Fact::Bool(f.section_enabled)),
        ("purpose_given", Fact::Bool(f.purpose_given)),
    ];
    bundle()?.decide(principal, org, &[], org, &facts)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;

    const READ: RestrictedRecordFacts = RestrictedRecordFacts {
        operation: Operation::Read,
        actor_manages_directory: true,
        subject_is_self: false,
        section_enabled: true,
        purpose_given: true,
    };

    #[test]
    fn compiles_strictly_and_permits_a_purposed_read_by_a_holder() {
        assert_eq!(decide("u", "o", READ), Ok(true));
    }

    #[test]
    fn a_read_needs_a_holder_and_a_purpose_and_never_the_own_record() {
        let flips: [fn(&mut RestrictedRecordFacts); 3] = [
            |f| f.actor_manages_directory = false,
            |f| f.purpose_given = false,
            |f| f.subject_is_self = true,
        ];
        for flip in flips {
            let mut facts = READ;
            flip(&mut facts);
            assert_eq!(decide("u", "o", facts), Ok(false), "{facts:?}");
        }
        // A read does not depend on the switch: collected data stays visible.
        let off = RestrictedRecordFacts {
            section_enabled: false,
            ..READ
        };
        assert_eq!(decide("u", "o", off), Ok(true));
    }

    #[test]
    fn a_write_needs_the_switch_on_and_a_void_does_not() {
        let write = RestrictedRecordFacts {
            operation: Operation::Write,
            purpose_given: false,
            ..READ
        };
        assert_eq!(decide("u", "o", write), Ok(true));
        let write_off = RestrictedRecordFacts {
            section_enabled: false,
            ..write
        };
        assert_eq!(decide("u", "o", write_off), Ok(false));
        let void_off = RestrictedRecordFacts {
            operation: Operation::Void,
            ..write_off
        };
        assert_eq!(decide("u", "o", void_off), Ok(true));
        let own = RestrictedRecordFacts {
            subject_is_self: true,
            ..void_off
        };
        assert_eq!(decide("u", "o", own), Ok(false));
    }

    #[test]
    fn missing_or_unknown_facts_are_refused() {
        let bundle = bundle().unwrap();
        let partial = [("operation", Fact::Str("read".into()))];
        assert!(bundle.decide("u", "o", &[], "o", &partial).is_err());
        let odd = [
            ("operation", Fact::Str("export".into())),
            ("actor_manages_directory", Fact::Bool(true)),
            ("subject_is_self", Fact::Bool(false)),
            ("section_enabled", Fact::Bool(true)),
            ("purpose_given", Fact::Bool(true)),
        ];
        assert_eq!(bundle.decide("u", "o", &[], "o", &odd), Ok(false));
        let foreign = [
            ("operation", Fact::Str("read".into())),
            ("actor_manages_directory", Fact::Bool(true)),
            ("subject_is_self", Fact::Bool(false)),
            ("section_enabled", Fact::Bool(true)),
            ("purpose_given", Fact::Bool(true)),
        ];
        assert_eq!(bundle.decide("u", "o", &[], "other", &foreign), Ok(false));
    }
}
