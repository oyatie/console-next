// SPDX-License-Identifier: LicenseRef-Proprietary
//! The 완료 and 참조 tabs beside the open list.
use axum::Router;
use axum::routing::{get, post};

use super::{ActionInboxState, done, reference};

pub const ME_ACTION_INBOX_DONE_PATH: &str = "/api/v1/me/action-inbox/done";
pub const ME_ACTION_INBOX_REFERENCE_PATH: &str = "/api/v1/me/action-inbox/reference";
pub const ME_ACTION_INBOX_REFERENCE_READ_PATH: &str = "/api/v1/me/action-inbox/reference/{id}/read";

pub(super) fn routes(router: Router<ActionInboxState>) -> Router<ActionInboxState> {
    router
        .route(ME_ACTION_INBOX_DONE_PATH, get(done::list))
        .route(ME_ACTION_INBOX_REFERENCE_PATH, get(reference::list))
        .route(ME_ACTION_INBOX_REFERENCE_READ_PATH, post(reference::read))
}
