//! CAP-04 (decisions #28 load shedding): the per-process cap on bulk 발령
//! job drivers; past it the next job is 503 `bulk_lifecycle_busy` with
//! `Retry-After`, before anything is written.

use std::sync::atomic::{AtomicUsize, Ordering};

use crate::HrError;

/// Drivers one process runs at once; the next job is 503
/// `bulk_lifecycle_busy` with `Retry-After` (#28 load shedding).
/// a per-process cap; a tenant-fair queue if many tenants 발령 at once.
pub const MAX_DRIVERS: usize = 2;
/// The `Retry-After` of `bulk_lifecycle_busy`, in seconds.
pub const RETRY_AFTER_SECS: u32 = 15;
static DRIVERS: AtomicUsize = AtomicUsize::new(0);

/// One of the [`MAX_DRIVERS`] driver slots; released on drop.
#[derive(Debug)]
pub struct DriverSlot(());

impl DriverSlot {
    /// A free slot, or 503 `bulk_lifecycle_busy` (nothing is written).
    ///
    /// # Errors
    /// `bulk_lifecycle_busy` when every slot is taken.
    pub fn take() -> Result<Self, HrError> {
        DRIVERS
            .try_update(Ordering::AcqRel, Ordering::Acquire, |n| {
                (n < MAX_DRIVERS).then_some(n + 1)
            })
            .map(|_| Self(()))
            .map_err(|_| HrError {
                errors: None,
                status: http::StatusCode::SERVICE_UNAVAILABLE,
                code: "bulk_lifecycle_busy",
                message: format!(
                    "too many bulk personnel actions are running; retry in {RETRY_AFTER_SECS} s"
                ),
                refusals: None,
            })
    }
}

impl Drop for DriverSlot {
    fn drop(&mut self) {
        DRIVERS.fetch_sub(1, Ordering::AcqRel);
    }
}

#[cfg(test)]
mod tests {
    use super::DriverSlot;

    /// #28 load shedding: past [`super::MAX_DRIVERS`] the next job is 503
    /// `bulk_lifecycle_busy` (the route adds `Retry-After`) until one frees.
    #[test]
    fn a_driver_past_the_cap_is_shed_until_one_frees() {
        let first = DriverSlot::take();
        let second = DriverSlot::take();
        assert!(first.is_ok() && second.is_ok());
        let shed = DriverSlot::take()
            .err()
            .map(|e| (e.status.as_u16(), e.code));
        assert_eq!(shed, Some((503, "bulk_lifecycle_busy")));
        drop(first);
        assert!(DriverSlot::take().is_ok());
    }
}
