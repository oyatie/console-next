//! Clock helpers shared by job scheduling and its existing skew tests.
use crate::JobQueueError;
use console_kernel_core::{Clock, Timestamp};
use std::time::Duration as StdDuration;

pub fn schedule_after(clock: &dyn Clock, delay: StdDuration) -> Result<Timestamp, JobQueueError> {
    let delay =
        time::Duration::try_from(delay).map_err(|_| JobQueueError::ScheduleDelayTooLarge)?;
    clock
        .now()
        .checked_add(delay)
        .ok_or(JobQueueError::ScheduleDelayTooLarge)
}

#[derive(Clone, Copy)]
pub struct SkewedClock<'a> {
    inner: &'a dyn Clock,
    offset: time::Duration,
}

impl<'a> SkewedClock<'a> {
    #[must_use]
    pub fn new(inner: &'a dyn Clock, offset: time::Duration) -> Self {
        Self { inner, offset }
    }
}

impl Clock for SkewedClock<'_> {
    fn now(&self) -> Timestamp {
        self.inner.now() + self.offset
    }
}
