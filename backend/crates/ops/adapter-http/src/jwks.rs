// SPDX-License-Identifier: LicenseRef-Proprietary
use std::num::NonZeroU64;

use console_ops_application::SourceError;

use crate::{HttpReadLimits, HttpSource};

pub struct HttpJwksFetcher {
    source: HttpSource,
}

impl HttpJwksFetcher {
    pub fn new(
        jwks_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        Ok(Self {
            source: HttpSource::new_exact(jwks_url, interval_s, limits)?,
        })
    }

    pub async fn fetch_text(&self) -> Result<String, SourceError> {
        let bytes = self.source.get_exact_bytes().await?;
        String::from_utf8(bytes).map_err(|_| SourceError::Invalid)
    }
}
