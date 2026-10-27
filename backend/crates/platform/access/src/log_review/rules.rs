// SPDX-License-Identifier: LicenseRef-Proprietary
//! One resolved rule set; an undeclared threshold stays absent.
use console_kernel_core::{OrgId, SettingVersionId};
use console_settings_adapter_postgres::resolve_in_tx;
use console_settings_domain::{SettingError, SettingKey};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::PgConnection;
use std::collections::BTreeMap;
use time::OffsetDateTime;

use crate::{AccessError, AccessResult};

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Rules {
    pub time_zone: String,
    start_hour: Option<i64>,
    end_hour: Option<i64>,
    off_hours_min: Option<i64>,
    bulk_subjects_min: Option<i64>,
    denied_min: Option<i64>,
    downloads_per_day_min: Option<i64>,
    every_download: Option<bool>,
    pub versions: BTreeMap<String, SettingVersionId>,
}

impl Rules {
    pub async fn load(conn: &mut PgConnection, org: OrgId) -> AccessResult<Self> {
        use SettingKey::*;
        let keys = [
            AccessLogReviewTimeZone,
            AccessLogReviewOffHoursStartHour,
            AccessLogReviewOffHoursEndHour,
            AccessLogReviewOffHoursMin,
            AccessLogReviewBulkSubjectsMin,
            AccessLogReviewDeniedMin,
            AccessLogReviewDownloadsPerDayMin,
            AccessLogReviewEveryDownload,
        ];
        let as_of: OffsetDateTime = sqlx::query_scalar("SELECT now()")
            .fetch_one(&mut *conn)
            .await?;
        let resolved = resolve_in_tx(conn, org, &keys, None, as_of).await?;
        let mut values = Map::new();
        let mut versions = BTreeMap::new();
        for (key, value) in resolved {
            let value = match value {
                Ok(r) => {
                    versions.insert(key.as_str().to_owned(), r.version);
                    serde_json::to_value(r.value).map_err(AccessError::internal)?
                }
                Err(SettingError::FactUndeclared(_)) => Value::Null,
                Err(e) => return Err(AccessError::internal(e)),
            };
            let name = key
                .as_str()
                .rsplit('.')
                .next()
                .ok_or_else(|| AccessError::internal("invalid setting key"))?;
            values.insert(name.into(), value);
        }
        values.insert(
            "versions".into(),
            serde_json::to_value(versions).map_err(AccessError::internal)?,
        );
        serde_json::from_value(Value::Object(values)).map_err(AccessError::internal)
    }

    pub fn disabled_flags(&self) -> Vec<&'static str> {
        [
            ("download", self.every_download != Some(true)),
            ("download_repeat", self.downloads_per_day_min.is_none()),
            (
                "off_hours",
                self.off_hours_min.is_none()
                    || self.start_hour.is_none()
                    || self.end_hour.is_none(),
            ),
            ("bulk_subjects", self.bulk_subjects_min.is_none()),
            ("repeated_denial", self.denied_min.is_none()),
        ]
        .into_iter()
        .filter_map(|(flag, off)| off.then_some(flag))
        .collect()
    }
}
