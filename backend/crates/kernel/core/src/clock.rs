//! Clock port. Domains and use-cases take `&dyn Clock` so time-dependent
//! logic (escalation timers, retention purges, KPI windows) is deterministic
//! under test.

use crate::Timestamp;

pub trait Clock: Send + Sync {
    fn now(&self) -> Timestamp;
}

/// Production clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> Timestamp {
        time::OffsetDateTime::now_utc()
    }
}

/// Test clock pinned to a fixed instant.
#[derive(Debug, Clone, Copy)]
pub struct FixedClock(pub Timestamp);

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.0
    }
}

/// Format a wire timestamp in UTC, refusing values RFC 3339 cannot represent.
/// # Errors
/// Returns an internal error for an unrepresentable year or offset.
pub fn rfc3339(value: Timestamp) -> Result<String, crate::KernelError> {
    value
        .to_offset(time::UtcOffset::UTC)
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| crate::KernelError::internal("timestamp cannot be represented as RFC 3339"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wire_timestamp_is_utc_rfc3339_and_refuses_unrepresentable_values() {
        assert_eq!(
            rfc3339(time::macros::datetime!(2026-11-05 12:31:02.238349 +09:00)).unwrap(),
            "2026-11-05T03:31:02.238349Z"
        );
        assert_eq!(
            rfc3339(time::macros::datetime!(-0001-01-01 00:00 UTC))
                .unwrap_err()
                .kind,
            crate::ErrorKind::Internal
        );
    }

    #[test]
    fn fixed_clock_returns_pinned_instant() {
        let instant = time::macros::datetime!(2026-06-12 09:00:00 UTC);
        let clock = FixedClock(instant);
        assert_eq!(clock.now(), instant);
        assert_eq!(clock.now(), clock.now());
    }

    #[test]
    fn system_clock_is_utc_and_monotonic_enough() {
        let clock = SystemClock;
        let a = clock.now();
        let b = clock.now();
        assert!(b >= a);
        assert_eq!(a.offset(), time::UtcOffset::UTC);
    }
}
