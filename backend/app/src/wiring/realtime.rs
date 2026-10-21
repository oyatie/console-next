//! Realtime hub wiring.

use crate::state::DatabaseDependency;
use console_platform_realtime::PgRealtimeHub;
use std::sync::Arc;

pub(crate) fn realtime_hub_from_database(
    database: &DatabaseDependency,
) -> Option<Arc<PgRealtimeHub>> {
    match database {
        DatabaseDependency::Postgres(pool) => Some(Arc::new(PgRealtimeHub::new(
            pool.clone(),
            Default::default(),
        ))),
        DatabaseDependency::NotConfigured => None,
    }
}
