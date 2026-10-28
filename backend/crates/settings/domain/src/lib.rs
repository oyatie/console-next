//! Tenant settings registry (BW-00 / BW-27, decisions D0.3).
//!
//! Every tenant policy value is a [`SettingKey`] with a code-defined
//! [`SettingDef`]: default, bounds, which way is looser, and who may change
//! it. Tenants override values with append-only, effective-dated rows; the
//! resolution order is 사업장 → legal entity → tenant → code default.
//! Statutory numbers are not settings: they live in the statutory register
//! (BW-30).
//!
//! Layer: domain. Depends only on the kernel; no IO, no clock (`now` is a
//! parameter).
#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used, clippy::panic))]

pub mod change;
mod citations;
pub mod code_lists;
pub mod definition;
pub mod error;
pub mod keys;
pub mod resolve;
pub mod snapshot;
mod value;

pub use change::{AcceptedChange, Direction, LOOSENING_DELAY, check_change, direction};
pub use definition::{Governance, LooserWhen, SettingDef, SettingKind, SettingValue, Unit};
pub use error::SettingError;
pub use keys::{SettingKey, UnknownKey};
pub use resolve::{OverrideRow, resolve, resolve_chain};
pub use snapshot::{SettingsSnapshot, SnapshotEntry};
