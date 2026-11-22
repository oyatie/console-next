// SPDX-License-Identifier: LicenseRef-Proprietary
use std::{
    num::{NonZeroU64, NonZeroUsize},
    time::Duration,
};

use console_ops_application::alert_actions::{AlertmanagerSilencePost, AlertmanagerWriter};
use console_ops_application::{Alertmanager, AlertmanagerSnapshot, SourceError, SourceFuture};
use reqwest::{Client, Url};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

mod jwks;
mod status_feed;
mod victoriametrics;
mod vmalert;
pub use jwks::HttpJwksFetcher;
pub use status_feed::HttpStatusFeed;
pub use victoriametrics::HttpVictoriaMetrics;
pub use vmalert::HttpVmalert;

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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SilenceCreateResponse {
    #[serde(rename = "silenceID")]
    silence_id: String,
}

impl AlertmanagerWriter for HttpAlertmanager {
    fn create_silence(&self, req: &AlertmanagerSilencePost) -> SourceFuture<'_, String> {
        let body = serde_json::to_value(req);
        Box::pin(async move {
            let payload = body.map_err(|_| SourceError::Invalid)?;
            let resp: SilenceCreateResponse =
                self.source.post_json("api/v2/silences", &payload).await?;
            if resp.silence_id.trim().is_empty() {
                return Err(SourceError::Invalid);
            }
            Ok(resp.silence_id)
        })
    }

    fn delete_silence(&self, id: &str) -> SourceFuture<'_, ()> {
        let id = id.to_owned();
        Box::pin(async move {
            if id.is_empty()
                || id.contains("..")
                || id.chars().any(|c| {
                    matches!(c, '/' | '\\' | '?' | '#') || c.is_whitespace() || c.is_control()
                })
            {
                return Err(SourceError::Invalid);
            }
            self.source
                .delete_path(&format!("api/v2/silence/{id}"))
                .await
        })
    }
}

pub(crate) struct HttpSource {
    base: Url,
    client: Client,
    max_response_bytes: usize,
}

impl HttpSource {
    pub(crate) fn new(
        base_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        let mut source = Self::new_exact(base_url, interval_s, limits)?;
        source
            .base
            .set_path(&format!("{}/", source.base.path().trim_end_matches('/')));
        Ok(source)
    }

    pub(crate) fn new_exact(
        base_url: &str,
        interval_s: NonZeroU64,
        limits: HttpReadLimits,
    ) -> Result<Self, SourceError> {
        let timeout = Duration::from_millis(limits.request_timeout_ms.get());
        if timeout >= Duration::from_secs(interval_s.get()) {
            return Err(SourceError::Configuration);
        }
        let base = Url::parse(base_url).map_err(|_| SourceError::Configuration)?;
        if !matches!(base.scheme(), "http" | "https")
            || base.host_str().is_none()
            || base.query().is_some()
            || base.fragment().is_some()
            || !base.username().is_empty()
            || base.password().is_some()
        {
            return Err(SourceError::Configuration);
        }
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

    pub(crate) async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T, SourceError> {
        let url = self
            .base
            .join(path)
            .map_err(|_| SourceError::Configuration)?;
        let body = self.get_url_bytes(url).await?;
        serde_json::from_slice(&body).map_err(|_| SourceError::Invalid)
    }

    pub(crate) async fn get_with_query<T: DeserializeOwned>(
        &self,
        path: &str,
        query: &[(&str, &str)],
    ) -> Result<T, SourceError> {
        let mut url = self
            .base
            .join(path)
            .map_err(|_| SourceError::Configuration)?;
        {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in query {
                pairs.append_pair(k, v);
            }
        }
        let body = self.get_url_bytes(url).await?;
        serde_json::from_slice(&body).map_err(|_| SourceError::Invalid)
    }

    pub(crate) async fn get_exact_bytes(&self) -> Result<Vec<u8>, SourceError> {
        self.get_url_bytes(self.base.clone()).await
    }

    pub(crate) async fn post_json<B: Serialize, T: DeserializeOwned>(
        &self,
        path: &str,
        body: &B,
    ) -> Result<T, SourceError> {
        let url = self
            .base
            .join(path)
            .map_err(|_| SourceError::Configuration)?;
        let encoded = serde_json::to_vec(body).map_err(|_| SourceError::Invalid)?;
        let response = self
            .client
            .post(url)
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(encoded)
            .send()
            .await
            .map_err(|_| SourceError::Down)?;
        let bytes = self.read_bounded_response(response).await?;
        serde_json::from_slice(&bytes).map_err(|_| SourceError::Invalid)
    }

    pub(crate) async fn delete_path(&self, path: &str) -> Result<(), SourceError> {
        let url = self
            .base
            .join(path)
            .map_err(|_| SourceError::Configuration)?;
        let response = self
            .client
            .delete(url)
            .send()
            .await
            .map_err(|_| SourceError::Down)?;
        let _ = self.read_bounded_response(response).await?;
        Ok(())
    }

    async fn get_url_bytes(&self, url: Url) -> Result<Vec<u8>, SourceError> {
        let response = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|_| SourceError::Down)?;
        self.read_bounded_response(response).await
    }

    async fn read_bounded_response(
        &self,
        mut response: reqwest::Response,
    ) -> Result<Vec<u8>, SourceError> {
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
        Ok(body)
    }
}
