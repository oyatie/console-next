// SPDX-License-Identifier: LicenseRef-Proprietary
use time::OffsetDateTime;
use uuid::Uuid;

#[derive(Debug, Default)]
pub struct StepDecisionCommand {
    pub approved: bool,
    pub memo: Option<String>,
    pub expected_version: Option<String>,
    pub through_step: Option<Uuid>,
}

/// A read-time token: partial step decisions change it even before status changes.
#[must_use]
pub fn decision_version(
    updated_at: OffsetDateTime,
    latest_decision: Option<OffsetDateTime>,
) -> String {
    updated_at
        .max(latest_decision.unwrap_or(updated_at))
        .unix_timestamp_nanos()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_tracks_each_decision_and_cancellation_but_not_unrelated_rows() {
        let submitted = OffsetDateTime::UNIX_EPOCH;
        let first = submitted + time::Duration::seconds(1);
        let second = first + time::Duration::seconds(1);
        let cancelled = second + time::Duration::seconds(1);
        let v = decision_version(submitted, None);
        assert_eq!(v, decision_version(submitted, None));
        assert_ne!(v, decision_version(submitted, Some(first)));
        assert_ne!(
            decision_version(submitted, Some(first)),
            decision_version(submitted, Some(second))
        );
        assert_ne!(
            decision_version(submitted, Some(second)),
            decision_version(cancelled, Some(second))
        );
        assert_eq!(
            decision_version(cancelled, Some(second)),
            decision_version(cancelled, None)
        );
    }
}
