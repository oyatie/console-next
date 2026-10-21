//! `EmploymentError` and its mapping onto kernel error kinds.

use console_kernel_core::KernelError;
use console_ontology_canonical_domain::CanonicalPortError;
use uuid::Uuid;

#[derive(Debug, thiserror::Error)]
pub enum EmploymentError {
    #[error("preflight blocked the command: {0:?}")]
    Blocked(Vec<String>),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
    /// §3.9.1 변경 동결 창: the period-lock gate refused a live employment
    /// mutation, or the gate itself could not run (unparseable effective date,
    /// lock-lookup failure). The carried `KernelError` preserves its kind so
    /// `into_kernel_error` maps a closed window to Conflict (409) and a gate
    /// failure to Internal (500).
    #[error(transparent)]
    Frozen(KernelError),
    #[error("command {0} was already applied with a different payload")]
    DigestConflict(Uuid),
    #[error("stored receipt for command {0} names no dispatch target: {1}")]
    UnreadableReceipt(Uuid, String),
    /// `employment_source_bindings` PK is `(org_id, employee_id)`, so one
    /// `employment_id` can appear on N rows. Reads and revisions must not pick.
    #[error(
        "employment {employment_id} has {binding_count} source bindings; refuse ambiguous promote/transfer"
    )]
    AmbiguousSourceBinding {
        employment_id: Uuid,
        binding_count: usize,
    },
    #[error("employment {employment_id} has unreadable effective state: {reason}")]
    UnreadableEffectiveState { employment_id: Uuid, reason: String },
    #[error("employment {0} has an ACTIVE revision after its stored close; correction required")]
    UnresolvedReactivation(Uuid),
    #[error("org_unit_id {0} is not a known OrgUnit in this tenant")]
    UnknownOrgUnit(Uuid),
    #[error("job_position_id {0} is not a known JobPosition in this tenant")]
    UnknownJobPosition(Uuid),
    #[error(
        "employee {employee_id} matched ReassignOrgUnit but has no employment_source_bindings row; refuse unbound transfer"
    )]
    UnboundEmployeeForTransfer { employee_id: Uuid },
    #[error("fromOrgUnit/toOrgUnit must be OrgUnit UUIDs, not free-text team labels")]
    OrgUnitRefNotUuid,
}

impl CanonicalPortError for EmploymentError {
    fn into_kernel_error(self) -> KernelError {
        let message = self.to_string();
        match self {
            Self::Blocked(_)
            | Self::AmbiguousSourceBinding { .. }
            | Self::UnknownOrgUnit(_)
            | Self::UnknownJobPosition(_)
            | Self::UnboundEmployeeForTransfer { .. }
            | Self::OrgUnitRefNotUuid => KernelError::validation(message),
            Self::DigestConflict(_) | Self::UnresolvedReactivation(_) => {
                KernelError::conflict(message)
            }
            Self::Frozen(error) => error,
            Self::Database(_)
            | Self::UnreadableReceipt(_, _)
            | Self::UnreadableEffectiveState { .. } => KernelError::internal(message),
        }
    }
}

#[cfg(test)]
mod port_error_kind_tests {
    use super::*;
    use console_kernel_core::ErrorKind;
    use console_ontology_canonical_domain::CanonicalPortError;

    #[test]
    fn digest_conflict_is_conflict_not_internal() {
        assert_eq!(
            EmploymentError::DigestConflict(Uuid::nil())
                .into_kernel_error()
                .kind,
            ErrorKind::Conflict
        );
    }

    #[test]
    fn ambiguous_binding_is_validation() {
        assert_eq!(
            EmploymentError::AmbiguousSourceBinding {
                employment_id: Uuid::nil(),
                binding_count: 2,
            }
            .into_kernel_error()
            .kind,
            ErrorKind::Validation
        );
    }

    #[test]
    fn frozen_window_is_conflict_not_internal() {
        assert_eq!(
            EmploymentError::Frozen(KernelError::conflict("payroll period locked".to_owned()))
                .into_kernel_error()
                .kind,
            ErrorKind::Conflict
        );
    }

    #[test]
    fn frozen_unparseable_date_is_validation_not_internal() {
        assert_eq!(
            EmploymentError::Frozen(KernelError::validation("unparseable date".to_owned()))
                .into_kernel_error()
                .kind,
            ErrorKind::Validation
        );
    }
}
