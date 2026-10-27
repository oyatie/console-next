// SPDX-License-Identifier: LicenseRef-Proprietary
use std::{
    num::{NonZeroU64, NonZeroUsize},
    time::Duration,
};

use console_ops_application::{Alertmanager, AlertmanagerSnapshot, SourceError, SourceFuture};
use reqwest::{Client, Url};
use serde::Deserialize;
use serde::de::DeserializeOwned;

#[derive(Clone, Copy, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct HttpReadLimits {
    pub request_timeout_ms: NonZeroU64,
    pub max_response_bytes: NonZeroUsize,
}

pub struct HttpAlertmanager {
    source: HttpSource,
}

impl HttpAlertmanager {
    pub fn new(
        base_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        Ok(Self {
            source: HttpSource::new(base_url, interval_s, limits)?,
        })
    }
}

impl Alertmanager for HttpAlertmanager {
    fn read(&self) -> SourceFuture<'_, AlertmanagerSnapshot> {
        Box::pin(async {
            let (alerts, silences, status) = tokio::try_join!(
                self.source.get("api/v2/alerts"),
                self.source.get("api/v2/silences"),
                self.source.get("api/v2/status"),
            )?;
            let snapshot = AlertmanagerSnapshot {
                alerts,
                silences,
                status,
            };
            if snapshot.alerts.iter().any(|alert| {
                alert.fingerprint.is_empty()
                    || alert.labels.get("alertname").is_none_or(String::is_empty)
            }) {
                return Err(SourceError::Invalid);
            }
            Ok(snapshot)
        })
    }
}

struct HttpSource {
    base: Url,
    client: Client,
    max_response_bytes: usize,
}

impl HttpSource {
    fn new(
        base_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        let timeout = Duration::from_millis(limits.request_timeout_ms.get());
        if timeout >= Duration::from_secs(interval_s.get()) {
            return Err(SourceError::Configuration);
        }
        let mut base = Url::parse(base_url).map_err(|_| SourceError::Configuration)?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || base.query().is_some()
            || base.fragment().is_some()
            || !base.username().is_empty()
            || base.password().is_some()
        {
            return Err(SourceError::Configuration);
        }
        base.set_path(&format!("{}/", base.path().trim_end_matches('/')));
        let client = Client::builder()
            .timeout(timeout)
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| SourceError::Configuration)?;
        Ok(Self {
            base,
            client,
            max_response_bytes: limits.max_response_bytes.get(),
        })
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, SourceError> {
        let url = self
            .base
            .join(path)
            .map_err(|_| SourceError::Configuration)?;
        let mut response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| SourceError::Down)?;
        if !response.status().is_success() {
            return Err(SourceError::Down);
        }
        if response
            .content_length()
            .is_some_and(|size| u128::from(size) > self.max_response_bytes as u128)
        {
            return Err(SourceError::Invalid);
        }
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|_| SourceError::Down)? {
            if chunk.len() > self.max_response_bytes - body.len() {
                return Err(SourceError::Invalid);
            }
            body.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&body).map_err(|_| SourceError::Invalid)
    }
}
