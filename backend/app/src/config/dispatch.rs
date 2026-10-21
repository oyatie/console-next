//! Dispatch timer configuration.

use crate::config::DEFAULT_DISPATCH_ACCEPT_WINDOW_SECS;
use crate::config::DEFAULT_DISPATCH_ALIMTALK_NO_ACK_SECS;
use crate::config::DEFAULT_DISPATCH_FORCE_ASSIGN_ALERT_SECS;
use crate::config::DEFAULT_DISPATCH_GPS_FRESHNESS_SECS;
use crate::config::parse::parse_time_duration_secs;
use crate::error::AppError;
use console_dispatch_domain::DispatchTimerConfig;
use std::collections::HashMap;

pub(crate) fn dispatch_timer_config_from_vars(
    vars: &HashMap<String, String>,
) -> Result<DispatchTimerConfig, AppError> {
    Ok(DispatchTimerConfig {
        accept_window: parse_time_duration_secs(
            vars.get("CONSOLE_DISPATCH_ACCEPT_WINDOW_SECS"),
            DEFAULT_DISPATCH_ACCEPT_WINDOW_SECS,
            "CONSOLE_DISPATCH_ACCEPT_WINDOW_SECS",
        )?,
        force_assign_alert_after: parse_time_duration_secs(
            vars.get("CONSOLE_DISPATCH_FORCE_ASSIGN_ALERT_SECS"),
            DEFAULT_DISPATCH_FORCE_ASSIGN_ALERT_SECS,
            "CONSOLE_DISPATCH_FORCE_ASSIGN_ALERT_SECS",
        )?,
        alimtalk_no_ack_after: parse_time_duration_secs(
            vars.get("CONSOLE_DISPATCH_ALIMTALK_NO_ACK_SECS"),
            DEFAULT_DISPATCH_ALIMTALK_NO_ACK_SECS,
            "CONSOLE_DISPATCH_ALIMTALK_NO_ACK_SECS",
        )?,
        gps_ping_freshness: parse_time_duration_secs(
            vars.get("CONSOLE_DISPATCH_GPS_FRESHNESS_SECS"),
            DEFAULT_DISPATCH_GPS_FRESHNESS_SECS,
            "CONSOLE_DISPATCH_GPS_FRESHNESS_SECS",
        )?,
    })
}
