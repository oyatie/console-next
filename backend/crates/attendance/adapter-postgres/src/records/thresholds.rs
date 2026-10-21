//! Read effective settings once per distinct employer in a records request.
use std::collections::{HashMap, HashSet};

use console_attendance_application::records::thresholds::{KEYS, from_settings};
use console_attendance_domain::records::Thresholds;
use console_kernel_core::OrgId;
use console_platform_db::settings_read::resolve_in_tx;
use sqlx::{Postgres, Transaction};
use time::OffsetDateTime;
use uuid::Uuid;

use crate::schedule::ScheduleStoreError;

pub(crate) struct RecordSettings(HashMap<Option<Uuid>, Thresholds>);

impl RecordSettings {
    pub(crate) async fn load(
        tx: &mut Transaction<'_, Postgres>,
        org: Uuid,
        entities: impl IntoIterator<Item = Option<Uuid>>,
    ) -> Result<Self, ScheduleStoreError> {
        let entities = entities.into_iter().collect::<HashSet<_>>();
        let now: OffsetDateTime = sqlx::query_scalar("SELECT now()")
            .fetch_one(tx.as_mut())
            .await?;
        let mut settings = HashMap::new();
        for entity in entities {
            let resolved = resolve_in_tx(tx.as_mut(), OrgId::from_uuid(org), &KEYS, entity, now)
                .await
                .map_err(|_| ScheduleStoreError::Corrupt("attendance settings"))?;
            let value = from_settings(&resolved)
                .map_err(|_| ScheduleStoreError::Corrupt("attendance thresholds"))?;
            settings.insert(entity, value);
        }
        Ok(Self(settings))
    }

    pub(crate) fn for_entity(
        &self,
        entity: Option<Uuid>,
    ) -> Result<Thresholds, ScheduleStoreError> {
        self.0
            .get(&entity)
            .copied()
            .ok_or(ScheduleStoreError::Corrupt("attendance setting scope"))
    }
}
