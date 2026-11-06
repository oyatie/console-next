// SPDX-License-Identifier: LicenseRef-Proprietary
//! Deployment-wide realtime budgets; invalid overrides refuse startup.

use std::collections::HashMap;
use std::time::Duration;

use console_platform_realtime::RealtimeHubConfig;

use crate::error::AppError;

pub(crate) fn from_vars(vars: &HashMap<String, String>) -> Result<RealtimeHubConfig, AppError> {
    let mut config = RealtimeHubConfig::default();
    for (name, target) in [
        (
            "CONSOLE_REALTIME_MAX_WS_PER_ACCOUNT",
            &mut config.max_ws_per_account,
        ),
        ("CONSOLE_REALTIME_MAX_WS_TOTAL", &mut config.max_ws_total),
        (
            "CONSOLE_REALTIME_MAX_REPLAY_ROWS",
            &mut config.max_replay_rows,
        ),
    ] {
        if let Some(raw) = vars.get(name) {
            *target = raw
                .parse::<usize>()
                .ok()
                .filter(|n| *n > 0)
                .ok_or_else(|| AppError::Config(format!("{name} must be a positive integer")))?;
        }
    }
    if let Some(raw) = vars.get("CONSOLE_REALTIME_REPLAY_TIMEOUT_SECS") {
        let secs = raw.parse::<u32>().ok().filter(|n| *n > 0).ok_or_else(|| {
            AppError::Config(
                "CONSOLE_REALTIME_REPLAY_TIMEOUT_SECS must be a positive 32-bit integer".into(),
            )
        })?;
        config.replay_timeout = Duration::from_secs(u64::from(secs));
    }
    Ok(config)
}
