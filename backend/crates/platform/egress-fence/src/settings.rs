//! `CONSOLE_EGRESS_FENCE_*` configuration.
//!
//! * `CONSOLE_EGRESS_FENCE_STUB_MODE=local|dev|development|test|e2e`: always
//!   open. Explicit, like `CONSOLE_EMAIL_STUB_MODE`, so a missing variable can
//!   never open the fence.
//! * The live group, all required together: `_CF_ZONE_ID`, `_CF_RECORD` (the
//!   `console` hostname), `_CF_TOKEN` (Zone:DNS:Read only), `_EXPECTED_CONTENT`
//!   (this site's `<tunnel-uuid>.cfargotunnel.com`), `_FAIL_AFTER_SECS`.
//!   `_CF_API_BASE` is optional (the public Cloudflare v4 endpoint).
//! * Neither: unconfigured, so the fence never opens.
//!
//! A partial live group, or a live group next to a stub mode, refuses to start.

use std::fmt::{Debug, Display, Formatter};
use std::time::Duration;

const PREFIX: &str = "CONSOLE_EGRESS_FENCE_";
const DEFAULT_API_BASE: &str = "https://api.cloudflare.com/client/v4";

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid egress fence configuration: {0}")]
pub struct FenceConfigError(pub String);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FenceStubMode {
    Local,
    Development,
    Test,
    E2e,
}

impl Display for FenceStubMode {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Local => "local",
            Self::Development => "development",
            Self::Test => "test",
            Self::E2e => "e2e",
        })
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct LiveFenceConfig {
    pub api_base: String,
    pub zone_id: String,
    pub record_name: String,
    pub api_token: String,
    pub expected_content: String,
    pub fail_after: Duration,
}

impl Debug for LiveFenceConfig {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LiveFenceConfig")
            .field("api_base", &self.api_base)
            .field("zone_id", &self.zone_id)
            .field("record_name", &self.record_name)
            .field("api_token", &"<redacted>")
            .field("expected_content", &self.expected_content)
            .field("fail_after", &self.fail_after)
            .finish()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FenceMode {
    Live(LiveFenceConfig),
    Stub(FenceStubMode),
    Unconfigured,
}

pub fn read_mode(var: impl Fn(&str) -> Option<String>) -> Result<FenceMode, FenceConfigError> {
    let get = |suffix: &str| {
        var(&format!("{PREFIX}{suffix}"))
            .map(|value| value.trim().to_owned())
            .filter(|value| !value.is_empty())
    };
    let stub = get("STUB_MODE").map(|raw| parse_stub(&raw)).transpose()?;
    let live = [
        "CF_ZONE_ID",
        "CF_RECORD",
        "CF_TOKEN",
        "EXPECTED_CONTENT",
        "FAIL_AFTER_SECS",
    ]
    .map(|suffix| (suffix, get(suffix)));
    let present = live.iter().filter(|(_, value)| value.is_some()).count();

    match (stub, present) {
        (Some(_), 1..) => Err(FenceConfigError(format!(
            "{PREFIX}STUB_MODE cannot be combined with the live group"
        ))),
        (Some(mode), 0) => Ok(FenceMode::Stub(mode)),
        (None, 0) => Ok(FenceMode::Unconfigured),
        (None, n) if n < live.len() => {
            let missing: Vec<String> = live
                .iter()
                .filter(|(_, value)| value.is_none())
                .map(|(suffix, _)| format!("{PREFIX}{suffix}"))
                .collect();
            Err(FenceConfigError(format!("missing {}", missing.join(", "))))
        }
        (None, _) => {
            let [zone, record, token, expected, fail_after] =
                live.map(|(_, v)| v.unwrap_or_default());
            let config = LiveFenceConfig {
                api_base: get("CF_API_BASE")
                    .unwrap_or_else(|| DEFAULT_API_BASE.to_owned())
                    .trim_end_matches('/')
                    .to_owned(),
                zone_id: checked(&zone, "CF_ZONE_ID", |c| c.is_ascii_hexdigit())?,
                record_name: checked(&record, "CF_RECORD", is_hostname_char)?,
                api_token: token,
                expected_content: checked(&expected, "EXPECTED_CONTENT", is_hostname_char)?,
                fail_after: parse_fail_after(&fail_after)?,
            };
            Ok(FenceMode::Live(config))
        }
    }
}

fn parse_stub(raw: &str) -> Result<FenceStubMode, FenceConfigError> {
    match raw.to_ascii_lowercase().as_str() {
        "local" => Ok(FenceStubMode::Local),
        "dev" | "development" => Ok(FenceStubMode::Development),
        "test" => Ok(FenceStubMode::Test),
        "e2e" => Ok(FenceStubMode::E2e),
        _ => Err(FenceConfigError(format!(
            "{PREFIX}STUB_MODE={raw:?}; expected local, dev, development, test or e2e"
        ))),
    }
}

/// Zone ids and hostnames go into the request path and query unescaped, so
/// they are restricted to characters that need no escaping.
fn checked(value: &str, suffix: &str, ok: fn(char) -> bool) -> Result<String, FenceConfigError> {
    if value.chars().all(ok) {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(FenceConfigError(format!(
            "{PREFIX}{suffix} has unexpected characters"
        )))
    }
}

fn is_hostname_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '-'
}

fn parse_fail_after(raw: &str) -> Result<Duration, FenceConfigError> {
    match raw.parse::<u64>() {
        Ok(secs) if secs > 0 => Ok(Duration::from_secs(secs)),
        _ => Err(FenceConfigError(format!(
            "{PREFIX}FAIL_AFTER_SECS must be a positive number of seconds"
        ))),
    }
}
