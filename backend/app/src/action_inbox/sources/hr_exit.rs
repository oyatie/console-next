//! Action-inbox source stub owned by lane EXIT (BW-05 exit-case clocks owed by the viewer).
//!
//! Pre-registered by PREREG-1 so the closed `ActionInboxSource` enum and its
//! composition arm never change again; the lane replaces only this body. Until
//! then the source contributes nothing: an exact, empty page.

use console_action_inbox_application::{ActionInboxSourcePage, ActionInboxSourceQuery};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;
use sqlx::PgPool;

pub(crate) async fn page(
    _pool: &PgPool,
    _principal: &Principal,
    _query: ActionInboxSourceQuery,
) -> Result<ActionInboxSourcePage, KernelError> {
    Ok(ActionInboxSourcePage {
        items: Vec::new(),
        total: 0,
        total_is_exact: true,
        has_more: false,
    })
}
