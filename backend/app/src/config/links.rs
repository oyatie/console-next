//! Native app-link association (`/.well-known/*`) configuration.

use crate::config::AppLinksConfig;
use crate::config::parse::non_empty;
use std::collections::HashMap;

/// Parse the native app-link association config from the environment.
///
/// Every field is optional: an unset/empty value yields an empty list (or
/// `None`), so the `/.well-known/*` endpoints serve a well-formed-but-empty
/// document instead of the process refusing to boot. The comma-separated lists
/// trim and drop blank entries so a trailing comma or stray whitespace is
/// harmless.
pub(crate) fn app_links_config_from_vars(vars: &HashMap<String, String>) -> AppLinksConfig {
    AppLinksConfig {
        ios_app_ids: parse_csv_list(vars.get("CONSOLE_IOS_APP_IDS")),
        android_package: non_empty(vars.get("CONSOLE_ANDROID_PACKAGE")),
        android_cert_sha256: parse_csv_list(vars.get("CONSOLE_ANDROID_CERT_SHA256")),
    }
}

/// Split a comma-separated env value into trimmed, non-empty entries. Returns an
/// empty `Vec` when unset or all-blank.
fn parse_csv_list(value: Option<&String>) -> Vec<String> {
    value
        .map(|raw| {
            raw.split(',')
                .map(str::trim)
                .filter(|entry| !entry.is_empty())
                .map(ToOwned::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
