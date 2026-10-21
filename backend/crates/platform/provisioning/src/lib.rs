//! Bulk roster provisioning and passkey cold-start.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

mod bootstrap;
mod catalog;
mod dev_principal;
mod error;
mod first_enrollment;
mod onboarding;
mod platform;
mod roster;

pub use bootstrap::*;
pub use dev_principal::*;
pub use error::*;
pub use first_enrollment::*;
pub use platform::*;
pub use roster::*;
