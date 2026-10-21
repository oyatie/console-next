//! What the adapter reads from the server environment.

use std::time::Duration;

use time::Date;
use url::Url;

/// One key from the environment. Its `Debug` never prints the key.
#[derive(Clone, Default)]
pub struct KeyConfig {
    pub(crate) key: Option<String>,
    pub expires_on: Option<Date>,
}

impl std::fmt::Debug for KeyConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeyConfig")
            .field("configured", &self.key.is_some())
            .field("expires_on", &self.expires_on)
            .finish()
    }
}

impl KeyConfig {
    #[must_use]
    pub fn new(key: Option<String>, expires_on: Option<Date>) -> Self {
        Self {
            key: key.filter(|k| !k.trim().is_empty()),
            expires_on,
        }
    }
}

/// Everything the adapter reads from the environment.
#[derive(Debug, Clone)]
pub struct JusoConfig {
    pub street: KeyConfig,
    pub detail: KeyConfig,
    pub base_url: Url,
    pub timeout: Duration,
    pub per_user_per_minute: u32,
}

const DEFAULT_BASE_URL: &str = "https://business.juso.go.kr";

impl JusoConfig {
    /// Reads `STREET_JUSO_API_KEY`, `DETAILED_JUSO_API_KEY`, their optional
    /// `*_EXPIRES_ON` (YYYY-MM-DD), and the operator knobs `JUSO_BASE_URL`,
    /// `JUSO_TIMEOUT_MS` (default 3000) and `JUSO_RATE_PER_MINUTE` (default 30).
    #[must_use]
    pub fn from_env() -> Self {
        Self::from_lookup(|name| std::env::var(name).ok())
    }

    /// As [`JusoConfig::from_env`], over any variable source (the app's own
    /// configuration map, so tests never read the process environment).
    #[must_use]
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Self {
        let date = |name: &str| {
            get(name).and_then(|v| {
                Date::parse(
                    v.trim(),
                    time::macros::format_description!("[year]-[month]-[day]"),
                )
                .ok()
            })
        };
        let base_url = get("JUSO_BASE_URL")
            .and_then(|u| Url::parse(&u).ok())
            .or_else(|| Url::parse(DEFAULT_BASE_URL).ok())
            .unwrap_or_else(unreachable_url);
        Self {
            street: KeyConfig::new(
                get("STREET_JUSO_API_KEY"),
                date("STREET_JUSO_API_KEY_EXPIRES_ON"),
            ),
            detail: KeyConfig::new(
                get("DETAILED_JUSO_API_KEY"),
                date("DETAILED_JUSO_API_KEY_EXPIRES_ON"),
            ),
            base_url,
            timeout: Duration::from_millis(
                get("JUSO_TIMEOUT_MS")
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(3000),
            ),
            per_user_per_minute: get("JUSO_RATE_PER_MINUTE")
                .and_then(|v| v.parse().ok())
                .unwrap_or(30),
        }
    }
}

#[allow(clippy::expect_used)]
fn unreachable_url() -> Url {
    Url::parse("http://127.0.0.1:9/").expect("static url parses")
}
