//! The actions an exit case's state admits (moved from `app/src/hr.rs`,
//! R2-exits).

use serde::Serialize;

#[derive(Debug, Serialize)]
pub struct ExitCaseNextAction {
    pub key: String,
}

/// The actions a case's state admits, as keys; the client owns labels and
/// routes. A case a 전적 opened is never rejected or cancelled on its own:
/// the 전적 is withdrawn or rescinded instead, and the case goes with it.
pub fn exit_case_next_actions(
    status: &str,
    follows_group_transfer: bool,
) -> Vec<ExitCaseNextAction> {
    let keys: &[&str] = match status {
        "REPORTED" => &["confirm_exit", "cancel_exit", "reject_exit"],
        "HR_CONFIRMED" => &["confirm_exit_hq", "reject_exit"],
        "HQ_CONFIRMED" | "SETTLEMENT_READY" | "APPROVAL_DRAFTED" => {
            &["prepare_settlement", "reject_exit"]
        }
        _ => &[],
    };
    keys.iter()
        .filter(|key| !(follows_group_transfer && matches!(**key, "cancel_exit" | "reject_exit")))
        .map(|key| ExitCaseNextAction {
            key: (*key).to_owned(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::exit_case_next_actions;

    fn keys(status: &str, group: bool) -> Vec<String> {
        exit_case_next_actions(status, group)
            .into_iter()
            .map(|a| a.key)
            .collect()
    }

    #[test]
    fn a_group_transfer_case_moves_forward_only() {
        assert_eq!(
            keys("HR_CONFIRMED", false),
            ["confirm_exit_hq", "reject_exit"]
        );
        assert_eq!(keys("HR_CONFIRMED", true), ["confirm_exit_hq"]);
        assert_eq!(
            keys("REPORTED", false),
            ["confirm_exit", "cancel_exit", "reject_exit"]
        );
        assert_eq!(keys("SETTLEMENT_READY", true), ["prepare_settlement"]);
        assert!(keys("SUBMITTED", true).is_empty());
    }

    #[test]
    fn cancellation_is_offered_only_before_hr_confirmation() {
        for state in [
            "HR_CONFIRMED",
            "HQ_CONFIRMED",
            "SETTLEMENT_READY",
            "APPROVAL_DRAFTED",
            "SUBMITTED",
        ] {
            assert!(
                !keys(state, false).iter().any(|k| k == "cancel_exit"),
                "{state}"
            );
        }
        assert!(keys("REPORTED", false).iter().any(|k| k == "cancel_exit"));
    }
}
