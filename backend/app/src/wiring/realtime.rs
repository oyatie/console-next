//! Realtime hub wiring.

use crate::state::DatabaseDependency;
use console_platform_realtime::{PgRealtimeHub, RealtimeHubConfig};
use std::sync::Arc;

pub(crate) fn realtime_hub_from_database(
    database: &DatabaseDependency,
    config: RealtimeHubConfig,
) -> Option<Arc<PgRealtimeHub>> {
    match database {
        DatabaseDependency::Postgres(pool) => {
            Some(Arc::new(PgRealtimeHub::new(pool.clone(), config)))
        }
        DatabaseDependency::NotConfigured => None,
    }
}
