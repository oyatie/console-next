//! Tenant setup phase (SETUP → 운영 시작 → OPERATING), shared by every context
//! that must refuse or relax a write depending on it.
//!
//! The phase row lives in `tenant_phase` (onboarding owns it). A missing row
//! reads as OPERATING: fail closed, so a tenant that slipped past provisioning
//! is governed, never silently ungoverned.

use crate::KernelError;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum TenantPhase {
    Setup,
    Operating,
}

impl TenantPhase {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Setup => "SETUP",
            Self::Operating => "OPERATING",
        }
    }

    /// The stored value, or OPERATING for a missing/unknown row (fail closed).
    #[must_use]
    pub fn from_db(raw: Option<&str>) -> Self {
        match raw {
            Some("SETUP") => Self::Setup,
            _ => Self::Operating,
        }
    }
}

/// How a write was admitted; stored on every revision row and audit event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ChangeMode {
    /// An authorized direct edit outside a governed transition.
    Direct,
    /// Applied immediately during SETUP; audited and listed in the go-live preview.
    Setup,
    /// Applied through the operating-phase rules.
    Governed,
    /// Decided by the only eligible holder (decisions.md #7 case B).
    SoleHolder,
    /// Written by a data migration; needs a person's confirmation.
    Migration,
}

impl ChangeMode {
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "DIRECT",
            Self::Setup => "SETUP",
            Self::Governed => "GOVERNED",
            Self::SoleHolder => "SOLE_HOLDER",
            Self::Migration => "MIGRATION",
        }
    }
}

/// What a write does, for the SETUP/OPERATING admission rule (design §5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteClass {
    /// Legal entity / registration / workplace create or revise.
    EntityStructure,
    /// Identifier correction (사업자등록번호, 법인등록번호, 사업자 구분).
    IdentifierCorrection,
    /// Org units created or changed without an org-change proposal.
    OrgStructure,
    /// Undo a mistaken record (`setup.void_*`).
    SetupVoid,
    /// Exits, payroll apply, period close.
    Operational,
    /// Leave (휴직 / 복직) and transfers (전근 / 전적): a setup record while
    /// migrating in, governed after 운영 시작 (decisions #26).
    LifecycleRecord,
}

pub const PHASE_NOT_SETUP: &str = "phase_not_setup";
pub const PHASE_NOT_OPERATING: &str = "phase_not_operating";
pub const IDENTIFIER_LOCKED: &str = "identifier_locked";

/// Admit a write in `phase`, or refuse it with a stable code. The caller reads
/// the phase under `FOR SHARE` in the write's transaction, so a concurrent
/// 운영 시작 (which takes `FOR UPDATE`) cannot interleave.
///
/// # Errors
/// - `phase_not_operating` for an operational write during SETUP;
/// - `phase_not_setup` for a setup-only write after 운영 시작;
/// - `identifier_locked` for an identifier correction after 운영 시작
///   (BW-06 high exception path; not built yet).
pub fn admit_write(phase: TenantPhase, class: WriteClass) -> Result<ChangeMode, KernelError> {
    match (phase, class) {
        (TenantPhase::Setup, WriteClass::Operational) => {
            Err(KernelError::conflict("available after 운영 시작 (go-live)")
                .with_code(PHASE_NOT_OPERATING))
        }
        (TenantPhase::Setup, _) => Ok(ChangeMode::Setup),
        (
            TenantPhase::Operating,
            WriteClass::EntityStructure | WriteClass::Operational | WriteClass::LifecycleRecord,
        ) => Ok(ChangeMode::Governed),
        (TenantPhase::Operating, WriteClass::IdentifierCorrection) => Err(KernelError::conflict(
            "identifier corrections after 운영 시작 need a governed exception",
        )
        .with_code(IDENTIFIER_LOCKED)),
        (TenantPhase::Operating, WriteClass::OrgStructure | WriteClass::SetupVoid) => {
            Err(KernelError::conflict("only available during setup").with_code(PHASE_NOT_SETUP))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_row_is_operating() {
        assert_eq!(TenantPhase::from_db(None), TenantPhase::Operating);
        assert_eq!(
            TenantPhase::from_db(Some("garbage")),
            TenantPhase::Operating
        );
        assert_eq!(TenantPhase::from_db(Some("SETUP")), TenantPhase::Setup);
    }

    #[test]
    fn stored_strings_match_the_wire_names() {
        // as_str is what revision rows and the phase row store; serde is what the API sends.
        let wire = |v: serde_json::Value| v.as_str().unwrap().to_owned();
        for p in [TenantPhase::Setup, TenantPhase::Operating] {
            assert_eq!(p.as_str(), wire(serde_json::to_value(p).unwrap()));
            assert_eq!(TenantPhase::from_db(Some(p.as_str())), p);
        }
        for m in [
            ChangeMode::Setup,
            ChangeMode::Governed,
            ChangeMode::SoleHolder,
            ChangeMode::Migration,
        ] {
            assert_eq!(m.as_str(), wire(serde_json::to_value(m).unwrap()));
        }
    }

    #[test]
    fn admission_table() {
        use TenantPhase::{Operating, Setup};
        use WriteClass::*;
        let code = |p, c| admit_write(p, c).err().and_then(|e| e.code);
        assert_eq!(admit_write(Setup, OrgStructure).unwrap(), ChangeMode::Setup);
        assert_eq!(admit_write(Setup, SetupVoid).unwrap(), ChangeMode::Setup);
        assert_eq!(code(Setup, Operational), Some(PHASE_NOT_OPERATING));
        assert_eq!(
            admit_write(Setup, LifecycleRecord).unwrap(),
            ChangeMode::Setup
        );
        assert_eq!(
            admit_write(Operating, LifecycleRecord).unwrap(),
            ChangeMode::Governed
        );
        assert_eq!(
            admit_write(Operating, EntityStructure).unwrap(),
            ChangeMode::Governed
        );
        assert_eq!(code(Operating, OrgStructure), Some(PHASE_NOT_SETUP));
        assert_eq!(code(Operating, SetupVoid), Some(PHASE_NOT_SETUP));
        assert_eq!(
            code(Operating, IdentifierCorrection),
            Some(IDENTIFIER_LOCKED)
        );
    }
}
