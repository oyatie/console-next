// SPDX-License-Identifier: LicenseRef-Proprietary
//! Build diagnostic dependencies once, before serving requests.
use crate::{config::AppConfig, error::AppError};
use std::sync::Arc;
pub(super) fn dependencies(config: &AppConfig) -> Result<(Arc<str>, reqwest::Client), AppError> {
    let release = config
        .web_dist
        .as_ref()
        .and_then(|dist| std::fs::read_to_string(dist.join("index.html")).ok())
        .as_deref()
        .and_then(crate::http::client_errors::dist_build)
        .unwrap_or(env!("CARGO_PKG_VERSION"))
        .into();
    if let Some(endpoint) = &config.support_log_query_url {
        let url = url::Url::parse(endpoint)
            .map_err(|_| AppError::Config("invalid CONSOLE_SUPPORT_LOG_QUERY_URL".into()))?;
        if !matches!(url.scheme(), "http" | "https")
            || url.host_str().is_none()
            || url.fragment().is_some()
        {
            return Err(AppError::Config(
                "invalid CONSOLE_SUPPORT_LOG_QUERY_URL".into(),
            ));
        }
    }
    let support_log_client = reqwest::Client::builder()
        .timeout(config.request_timeout)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| AppError::Config(error.to_string()))?;
    Ok((release, support_log_client))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn served_release_is_cached_even_when_the_entry_is_removed() {
        let dist = std::env::temp_dir().join(format!("support-dist-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dist).unwrap();
        std::fs::write(
            dist.join("index.html"),
            r#"<script src="/assets/index-actualRelease.js">"#,
        )
        .unwrap();
        let mut config = AppConfig::from_pairs(std::iter::empty::<(&str, &str)>()).unwrap();
        config.web_dist = Some(dist.clone());
        let state = crate::AppState::new(config, crate::DatabaseDependency::NotConfigured).unwrap();
        std::fs::remove_dir_all(dist).unwrap();
        assert_eq!(state.web_release.as_ref(), "actualRelease");
    }
    #[test]
    fn invalid_log_endpoints_fail_at_startup() {
        for endpoint in ["not a url", "file:///tmp/private", "http://logs/#secret"] {
            let config =
                AppConfig::from_pairs([("CONSOLE_SUPPORT_LOG_QUERY_URL", endpoint)]).unwrap();
            assert!(dependencies(&config).is_err());
        }
    }
}
