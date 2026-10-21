//! Per-user request budget for the address proxies (fixed one-minute window).
//!
//! in-process, one window per user per instance; a second app
//! instance doubles the budget. Move to a shared store if the app scales out.

use std::collections::HashMap;
use std::sync::Mutex;

use uuid::Uuid;

#[derive(Debug)]
pub(crate) struct RateLimit {
    per_minute: u32,
    windows: Mutex<HashMap<Uuid, (u64, u32)>>,
}

impl RateLimit {
    pub(crate) fn new(per_minute: u32) -> Self {
        Self {
            per_minute,
            windows: Mutex::new(HashMap::new()),
        }
    }

    /// Count one request of `user` in the minute `minute`; `false` when over budget.
    pub(crate) fn admit(&self, user: Uuid, minute: u64) -> bool {
        let Ok(mut windows) = self.windows.lock() else {
            return false; // a poisoned lock refuses (fail closed), never panics
        };
        if windows.len() > 10_000 {
            windows.retain(|_, (m, _)| *m == minute);
        }
        let slot = windows.entry(user).or_insert((minute, 0));
        if slot.0 != minute {
            *slot = (minute, 0);
        }
        if slot.1 >= self.per_minute {
            return false;
        }
        slot.1 += 1;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budget_is_per_user_and_per_minute() {
        let limit = RateLimit::new(2);
        let (a, b) = (Uuid::new_v4(), Uuid::new_v4());
        assert!(limit.admit(a, 1) && limit.admit(a, 1));
        assert!(!limit.admit(a, 1));
        assert!(limit.admit(b, 1));
        assert!(limit.admit(a, 2));
    }
}
