// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_application::health::StatusFeed;
use console_ops_application::{SourceError, SourceFuture};
use console_ops_domain::status::{StatusV2Snapshot, parse_status_v2_json};

use crate::{HttpReadLimits, HttpSource};

pub struct HttpStatusFeed {
    source: HttpSource,
}

impl HttpStatusFeed {
    pub fn new(
        status_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        Ok(Self {
            source: HttpSource::new_exact(status_url, interval_s, limits)?,
        })
    }
}

impl StatusFeed for HttpStatusFeed {
    fn read(&self) -> SourceFuture<'_, StatusV2Snapshot> {
        Box::pin(async {
            let bytes = self.source.get_exact_bytes().await?;
            let text = std::str::from_utf8(&bytes).map_err(|_| SourceError::Invalid)?;
            parse_status_v2_json(text).map_err(|_| SourceError::Invalid)
        })
    }
}
