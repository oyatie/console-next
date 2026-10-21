//! Typed item status (lifecycle-events.md §5.2). Stored as `status` +
//! `status_code`; the table's `lifecycle_case_items_status_shape` CHECK is the
//! same rule. A done item names what closed it; a bare tick does not exist.

use console_kernel_core::KernelError;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemStatus {
    /// Request-triggered with no request yet, or a window not yet open.
    PendingTrigger,
    Open,
    /// Cannot be completed until a fact is fixed; the code names the fix.
    Blocked(String),
    /// The console saw the fact (`observed_ref`).
    DoneObserved,
    /// An offline fact recorded with its evidence (`exception_id`).
    DoneAttested,
    /// A derived fact excludes it (`PRE_CONSOLE`, `SERVICE_GE_30_DAYS`, ...).
    NotApplicable(String),
    /// A governed override (`exception_id`).
    Waived,
    Cancelled(String),
    /// A done item invalidated by a later change; a linked correction item is the open one.
    CorrectionNeeded,
}

impl ItemStatus {
    /// # Errors
    /// Validation `lifecycle_item_status_invalid` for an unknown status or a
    /// code that the status does not take (or lacks).
    pub fn from_db(status: &str, code: Option<&str>) -> Result<Self, KernelError> {
        let coded = |make: fn(String) -> Self| {
            code.filter(|c| !c.is_empty())
                .map(|c| make(c.to_owned()))
                .ok_or_else(invalid)
        };
        let bare = |value: Self| code.map_or(Ok(value), |_| Err(invalid()));
        match status {
            "PENDING_TRIGGER" => bare(Self::PendingTrigger),
            "OPEN" => bare(Self::Open),
            "BLOCKED" => coded(Self::Blocked),
            "DONE_OBSERVED" => bare(Self::DoneObserved),
            "DONE_ATTESTED" => bare(Self::DoneAttested),
            "NOT_APPLICABLE" => coded(Self::NotApplicable),
            "WAIVED" => bare(Self::Waived),
            "CANCELLED" => coded(Self::Cancelled),
            "CORRECTION_NEEDED" => bare(Self::CorrectionNeeded),
            _ => Err(invalid()),
        }
    }

    #[must_use]
    pub fn to_db(&self) -> (&'static str, Option<&str>) {
        match self {
            Self::PendingTrigger => ("PENDING_TRIGGER", None),
            Self::Open => ("OPEN", None),
            Self::Blocked(code) => ("BLOCKED", Some(code)),
            Self::DoneObserved => ("DONE_OBSERVED", None),
            Self::DoneAttested => ("DONE_ATTESTED", None),
            Self::NotApplicable(code) => ("NOT_APPLICABLE", Some(code)),
            Self::Waived => ("WAIVED", None),
            Self::Cancelled(code) => ("CANCELLED", Some(code)),
            Self::CorrectionNeeded => ("CORRECTION_NEEDED", None),
        }
    }

    /// Terminal statuses never change again, except DONE_* to CORRECTION_NEEDED.
    #[must_use]
    pub const fn is_terminal(&self) -> bool {
        !matches!(self, Self::PendingTrigger | Self::Open | Self::Blocked(_))
    }
}

fn invalid() -> KernelError {
    KernelError::validation("lifecycle_item_status_invalid")
}

#[cfg(test)]
mod tests {
    use super::ItemStatus;

    #[test]
    fn statuses_round_trip_and_reject_a_wrong_code_shape() {
        let all = [
            ItemStatus::PendingTrigger,
            ItemStatus::Open,
            ItemStatus::Blocked("FIELDS_MISSING".into()),
            ItemStatus::DoneObserved,
            ItemStatus::DoneAttested,
            ItemStatus::NotApplicable("PRE_CONSOLE".into()),
            ItemStatus::Waived,
            ItemStatus::Cancelled("EVENT_WITHDRAWN".into()),
            ItemStatus::CorrectionNeeded,
        ];
        for status in &all {
            let (text, code) = status.to_db();
            assert_eq!(&ItemStatus::from_db(text, code).unwrap(), status);
        }
        assert_eq!(all.iter().filter(|s| s.is_terminal()).count(), 6);
        assert!(ItemStatus::from_db("NOT_APPLICABLE", None).is_err());
        assert!(ItemStatus::from_db("OPEN", Some("X")).is_err());
        assert!(ItemStatus::from_db("DONE", None).is_err());
    }
}
