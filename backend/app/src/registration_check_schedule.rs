// SPDX-License-Identifier: LicenseRef-Proprietary
use console_entity_adapter_postgres::PgEntityStore;
use console_entity_application::registration_check::RegistrationCheck;
use console_kernel_core::OrgId;
use std::sync::Arc;

pub(crate) async fn tick(pool: &sqlx::PgPool, port: Arc<dyn RegistrationCheck>) {
    if !port.availability().available {
        return;
    }
    // rls-arming: ok SECURITY DEFINER platform tenant enumeration, then tenant-armed checks.
    let tenants = sqlx::query_scalar::<_, uuid::Uuid>(
        "SELECT id FROM platform_list_organizations() ORDER BY id",
    )
    .fetch_all(pool) // rls-arming: ok SECURITY DEFINER platform tenant enumeration; subsequent reads are tenant-armed.
    .await;
    let tenants = match tenants {
        Ok(ids) => ids,
        Err(error) => {
            tracing::warn!(%error,"registration check tenant discovery failed");
            return;
        }
    };
    let store = PgEntityStore::new(pool.clone());
    for id in tenants {
        if let Err(error) = store
            .check_due_registrations(OrgId::from_uuid(id), port.clone())
            .await
        {
            tracing::warn!(%error,"registration check batch failed");
        }
    }
}
