// SPDX-License-Identifier: LicenseRef-Proprietary
//! Platform business zone, shared by scheduled org changes and the workbench.
// The existing platform zone applies until an organization zone fact exists.
pub const PLATFORM_TIMEZONE: &str = "Asia/Seoul";
pub const PLATFORM_UTC_OFFSET: time::UtcOffset = time::macros::offset!(+9);
