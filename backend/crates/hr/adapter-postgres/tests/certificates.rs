// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
//! Certificate runtime-role product contract.
#[path = "certificates/actions.rs"]
mod actions;
#[path = "certificates/fixture.rs"]
mod fixture;
#[path = "certificates/issuance.rs"]
mod issuance;
#[path = "support/lifecycle_grant.rs"]
#[allow(dead_code)]
mod lifecycle_grant;
#[path = "certificates/refusals.rs"]
mod refusals;

#[path = "certificates/regressions.rs"]
mod regressions;
