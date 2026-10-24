// SPDX-License-Identifier: LicenseRef-Proprietary
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::registration_check::{
    RegistrationCheckInbox, RegistrationCheckItem,
};
use console_kernel_core::KernelError;
use console_platform_authz::Principal;

/// Use the command's own Cedar decision and scope for inbox visibility.
/// # Errors
/// Scope or source read failure (closed, never widened).
pub async fn registration_check_inbox(
    store: &PgEntityStore,
    principal: &Principal,
) -> Result<Vec<RegistrationCheckItem>, KernelError> {
    let mut actor = crate::auth::actor_of(principal);
    actor.scope = crate::reach::reach(store, principal).await?;
    let mut items = store.list_check_items(&actor).await?;
    items.retain(|item| crate::auth::may_manage(principal, &actor.scope, &[item.legal_entity_id]));
    Ok(items)
}
