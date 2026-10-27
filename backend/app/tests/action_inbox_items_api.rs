// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "action_inbox_items/admission.rs"]
mod admission;
#[path = "support/http.rs"]
mod http;
#[path = "action_inbox_items/org_change.rs"]
mod org_change;
#[path = "../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
#[path = "../../test-support/person_fixtures.rs"]
mod person_fixtures;
