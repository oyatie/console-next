// SPDX-License-Identifier: LicenseRef-Proprietary
use std::{num::NonZeroU64, time::Duration};

use console_ops_application::{Alertmanager, AlertmanagerSnapshot, SourceError, SourceFuture};
use reqwest::{Client, Url};
use serde::de::DeserializeOwned;

pub struct HttpAlertmanager {
    source: HttpSource,
}

impl HttpAlertmanager {
    pub fn new(base_url: &str, interval_s: NonZeroU64) -> Result<Self, SourceError> {
        Ok(Self {
            source: HttpSource::new(base_url, interval_s)?,
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
}

impl HttpSource {
    fn new(base_url: &str, interval_s: NonZeroU64) -> Result<Self, SourceError> {
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
            .timeout(Duration::from_secs(interval_s.get()))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| SourceError::Configuration)?;
        Ok(Self { base, client })
    }

    async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, SourceError> {
        let url = self
            .base
            .join(path)
            .map_err(|_| SourceError::Configuration)?;
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| SourceError::Down)?;
        if !response.status().is_success() {
            return Err(SourceError::Down);
        }
        let body = response.bytes().await.map_err(|_| SourceError::Down)?;
        serde_json::from_slice(&body).map_err(|_| SourceError::Invalid)
    }
}
