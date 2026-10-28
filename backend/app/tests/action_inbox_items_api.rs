// SPDX-License-Identifier: LicenseRef-Proprietary
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
#[path = "action_inbox_items/admission.rs"]
mod admission;
#[path = "action_inbox_items/contract.rs"]
mod contract;
#[path = "action_inbox_items/draft_access.rs"]
mod draft_access;
#[allow(dead_code)]
#[path = "org_change_people/fixture.rs"]
mod draft_fixture;
#[path = "action_inbox_items/draft_refusals.rs"]
mod draft_refusals;
#[path = "support/go_live.rs"]
mod go_live;
#[allow(dead_code)]
#[path = "emp_ui_routes/harness.rs"]
mod harness;
#[path = "support/http.rs"]
mod http;
#[path = "action_inbox_items/legacy_draft.rs"]
mod legacy_draft;
#[path = "action_inbox_items/org_change.rs"]
mod org_change;
#[path = "../../test-support/org_change_fixtures.rs"]
mod org_change_fixtures;
#[path = "../../test-support/person_fixtures.rs"]
mod person_fixtures;
#[path = "action_inbox_items/withdrawal.rs"]
mod withdrawal;
