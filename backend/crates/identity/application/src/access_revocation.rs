//! When a leaver's access ends (access-model §5.3, governance-04, 고시 §5).
//!
//! The exit confirmation ends every grant the leaver's account holds at this
//! instant and, once it has passed, suspends the account and its sessions
//! (`console_identity_adapter_postgres::revoke_privileged_access`). This module
//! only decides the instant, from the `exit.access.revoke_mode.*` setting.

use console_kernel_core::Timestamp;
use time::{Date, Duration, Time, UtcOffset};

/// When privileged access ends, per the `exit.access.revoke_mode.*` settings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevokeMode {
    /// Revoke as soon as HR confirms the exit (`ON_CONFIRM`).
    OnConfirm,
    /// Revoke at the end of the exit date, KST (`END_OF_EXIT_DATE`).
    EndOfExitDate,
}

impl RevokeMode {
    /// The setting's code; an unknown code reads as the strictest mode.
    #[must_use]
    pub fn from_code(code: &str) -> Self {
        if code == "END_OF_EXIT_DATE" {
            Self::EndOfExitDate
        } else {
            Self::OnConfirm
        }
    }
}

const KST: UtcOffset = match UtcOffset::from_hms(9, 0, 0) {
    Ok(offset) => offset,
    Err(_) => UtcOffset::UTC,
};

/// The instant access ends: never later than the end of the 퇴직일 (KST), never
/// earlier than `now` (a past instant would not satisfy `valid_to > now`
/// elsewhere and means "now" anyway).
#[must_use]
pub fn access_end(mode: RevokeMode, exit_date: Date, now: Timestamp) -> Timestamp {
    match mode {
        RevokeMode::OnConfirm => now,
        RevokeMode::EndOfExitDate => {
            let end = exit_date
                .with_time(Time::MIDNIGHT)
                .assume_offset(KST)
                .saturating_add(Duration::DAY)
                .to_offset(UtcOffset::UTC);
            end.max(now)
        }
    }
}

#[cfg(test)]
mod tests {
    use time::macros::{date, datetime};

    use super::*;

    #[test]
    fn end_of_exit_date_is_kst_midnight_after_the_date() {
        let now = datetime!(2026-10-07 01:00 UTC);
        assert_eq!(
            access_end(RevokeMode::EndOfExitDate, date!(2026 - 10 - 07), now),
            datetime!(2026-10-07 15:00 UTC)
        );
    }

    #[test]
    fn a_past_exit_date_and_on_confirm_end_now() {
        let now = datetime!(2026-10-07 01:00 UTC);
        assert_eq!(
            access_end(RevokeMode::EndOfExitDate, date!(2026 - 10 - 01), now),
            now
        );
        assert_eq!(
            access_end(RevokeMode::OnConfirm, date!(2026 - 12 - 31), now),
            now
        );
    }

    #[test]
    fn an_unknown_mode_code_is_the_strictest() {
        assert_eq!(RevokeMode::from_code("bogus"), RevokeMode::OnConfirm);
        assert_eq!(
            RevokeMode::from_code("END_OF_EXIT_DATE"),
            RevokeMode::EndOfExitDate
        );
    }
}
