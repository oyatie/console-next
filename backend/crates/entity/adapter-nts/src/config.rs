// SPDX-License-Identifier: LicenseRef-Proprietary
use std::time::Duration;
use time::Date;
use url::Url;

#[derive(Clone)]
pub struct NtsConfig {
    pub(crate) key: Option<String>,
    pub expires_on: Option<Date>,
    pub base_url: Url,
    pub timeout: Duration,
    pub rate_per_minute: u32,
}
impl std::fmt::Debug for NtsConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NtsConfig")
            .field("configured", &self.key.is_some())
            .field("expires_on", &self.expires_on)
            .finish_non_exhaustive()
    }
}
impl NtsConfig {
    #[must_use]
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let base_url = get("NTS_BASE_URL")
            .and_then(|v| Url::parse(&v).ok())
            .filter(|u| {
                u.scheme() == "https"
                    || (u.scheme() == "http"
                        && u.host_str()
                            .is_some_and(|h| h == "127.0.0.1" || h == "localhost"))
            })
            .unwrap_or_else(default_url);
        let expiry = get("NTS_BUSINESSMAN_API_KEY_EXPIRES_ON").filter(|v| !v.trim().is_empty());
        let expires_on = expiry.as_ref().and_then(|v| {
            Date::parse(
                v.trim(),
                time::macros::format_description!("[year]-[month]-[day]"),
            )
            .ok()
        });
        Self {
            key: get("NTS_BUSINESSMAN_API_KEY")
                .filter(|v| !v.trim().is_empty() && (expiry.is_none() || expires_on.is_some())),
            expires_on,
            base_url,
            timeout: Duration::from_millis(
                get("NTS_TIMEOUT_MS")
                    .and_then(|v| v.parse::<u64>().ok())
                    .filter(|v| *v > 0)
                    .unwrap_or(3000),
            ),
            rate_per_minute: get("NTS_RATE_PER_MINUTE")
                .and_then(|v| v.parse::<u32>().ok())
                .filter(|v| *v > 0)
                .unwrap_or(30),
        }
    }
}
#[allow(clippy::expect_used)]
fn default_url() -> Url {
    Url::parse("https://api.odcloud.kr/api/nts-businessman/v1/").expect("provider URL")
}
