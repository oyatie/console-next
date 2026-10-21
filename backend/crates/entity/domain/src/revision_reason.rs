//! Revision reason codes (0h): the reason a person gives a dated change, and
//! the markers only the server writes. History, the N-1 version check and the
//! close/reopen paths read the markers, so a person sending one would forge
//! server provenance: every person-facing route parses through
//! [`person_reason`], which refuses them (422 `reason_code_reserved`).
//!
//! person reasons stay free text (≤ 100) until they join the BW-07
//! `ReasonDomain` roster (unit 0h-revision-reason-roster).

use serde::Serialize;

use crate::Issues;
use crate::refusal::REASON_CODE_RESERVED;

macro_rules! system_reasons {
    ($($variant:ident => $wire:literal,)+) => {
        /// A reason only the server writes into a revision row.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
        pub enum SystemReason {
            $(#[serde(rename = $wire)] $variant,)+
        }

        impl SystemReason {
            pub const ALL: &'static [Self] = &[$(Self::$variant,)+];

            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $wire,)+ }
            }

            #[must_use]
            pub fn parse(raw: &str) -> Option<Self> {
                match raw { $($wire => Some(Self::$variant),)+ _ => None }
            }
        }
    };
}

system_reasons! {
    // The first revision of a record.
    Create => "CREATE",
    // The N-1 copy a 법인명 change appends to each 사업자등록 (registration history hides it).
    LegalNameDerived => "LEGAL_NAME_DERIVED",
    // The 법인's VAT unit, re-derived when its 사업자등록 change.
    VatUnitDerived => "VAT_UNIT_DERIVED",
    // A 사업장 closed on its own (MR-14).
    WorkplaceClosed => "WORKPLACE_CLOSED",
    // A 사업장 / 사업자등록 closed with its 법인 (MR-15): 해산, 폐업.
    LegalEntityDissolved => "LEGAL_ENTITY_DISSOLVED",
    LegalEntityBusinessClosed => "LEGAL_ENTITY_BUSINESS_CLOSED",
    // The 법인's close corrected or withdrawn (company-19).
    LegalEntityCloseCorrected => "LEGAL_ENTITY_CLOSE_CORRECTED",
    LegalEntityCloseWithdrawn => "LEGAL_ENTITY_CLOSE_WITHDRAWN",
    // A setup batch undone.
    SetupUndo => "SETUP_UNDO",
}

impl SystemReason {
    /// The markers of a record closed with its 법인 (the close or a correction of it).
    pub const CLOSED_WITH_ENTITY: [Self; 3] = [
        Self::LegalEntityDissolved,
        Self::LegalEntityBusinessClosed,
        Self::LegalEntityCloseCorrected,
    ];

    /// The marker of a 법인 close by its reason.
    #[must_use]
    pub const fn entity_close(reason: crate::codes::CloseReason) -> Self {
        match reason {
            crate::codes::CloseReason::Dissolved => Self::LegalEntityDissolved,
            crate::codes::CloseReason::BusinessClosed => Self::LegalEntityBusinessClosed,
        }
    }
}

/// A reason a person gave: trimmed text of at most 100 characters that is no
/// [`SystemReason`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(transparent)]
pub struct PersonReason(String);

impl PersonReason {
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The required `reason_code` of a person's command; a server marker is
/// `reason_code_reserved`.
pub fn person_reason(is: &mut Issues, raw: Option<&str>) -> Option<PersonReason> {
    let text = is.text("reason_code", raw, 100, true)?;
    if SystemReason::parse(&text).is_some() {
        is.push("reason_code", REASON_CODE_RESERVED);
        return None;
    }
    Some(PersonReason(text))
}

/// Why a revision row was written: a person's reason or a server marker.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RevisionReason {
    Person(PersonReason),
    System(SystemReason),
}

impl From<PersonReason> for RevisionReason {
    fn from(reason: PersonReason) -> Self {
        Self::Person(reason)
    }
}

impl From<SystemReason> for RevisionReason {
    fn from(reason: SystemReason) -> Self {
        Self::System(reason)
    }
}

impl RevisionReason {
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Person(p) => p.as_str(),
            Self::System(s) => s.as_str(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(raw: &str) -> Result<PersonReason, Vec<&'static str>> {
        let mut is = Issues::default();
        let out = person_reason(&mut is, Some(raw));
        is.finish_opt(|| out)
            .map_err(|r| r.fields.iter().map(|f| f.code).collect())
    }

    #[test]
    fn every_server_marker_is_refused_as_a_person_reason() {
        for s in SystemReason::ALL {
            assert_eq!(run(s.as_str()), Err(vec![REASON_CODE_RESERVED]), "{s:?}");
            assert_eq!(
                run(&format!("  {}  ", s.as_str())),
                Err(vec![REASON_CODE_RESERVED])
            );
            assert_eq!(SystemReason::parse(s.as_str()), Some(*s));
        }
    }

    #[test]
    fn a_person_reason_is_trimmed_free_text() {
        assert_eq!(run(" CHANGE ").map(|r| r.0), Ok("CHANGE".into()));
        assert_eq!(
            run("SUSPENSION_SEASONAL").map(|r| r.0),
            Ok("SUSPENSION_SEASONAL".into())
        );
        assert_eq!(run(""), Err(vec![crate::refusal::REQUIRED]));
        assert_eq!(run(&"x".repeat(101)), Err(vec![crate::refusal::TOO_LONG]));
    }

    #[test]
    fn closes_map_to_their_markers() {
        use crate::codes::CloseReason;
        assert_eq!(
            SystemReason::entity_close(CloseReason::Dissolved).as_str(),
            "LEGAL_ENTITY_DISSOLVED"
        );
        assert_eq!(
            SystemReason::entity_close(CloseReason::BusinessClosed).as_str(),
            "LEGAL_ENTITY_BUSINESS_CLOSED"
        );
    }
}
