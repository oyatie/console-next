use serde::Deserialize;
use serde::Serialize;

#[derive(Debug, Deserialize)]
pub(crate) struct UpdateConsoleRolloutOptInRequest {
    pub(crate) opt_in: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UpdateConsoleRolloutOrgFlagRequest {
    pub(crate) enabled: bool,
    #[serde(default)]
    pub(crate) rollout_note: Option<String>,
}

#[derive(Debug, Deserialize)]
pub(crate) struct UpdateConsoleLegacyKillSwitchRequest {
    pub(crate) enabled: bool,
    #[serde(default, alias = "rollout_note")]
    pub(crate) reason: Option<String>,
}

#[derive(Debug, Serialize)]
pub(crate) struct ConsoleRolloutResponse {
    pub(crate) flag_key: &'static str,
    pub(crate) org_enabled: bool,
    pub(crate) org_rollout_enabled: bool,
    pub(crate) user_opted_in: bool,
    pub(crate) legacy_kill_switch_enabled: bool,
    pub(crate) kill_switch_active: bool,
    pub(crate) effective_new_console: bool,
    pub(crate) effective_route: &'static str,
    pub(crate) effective_route_for_opted_in_user: &'static str,
    pub(crate) effective_route_for_opted_out_user: &'static str,
    pub(crate) overrides_individual_toggles: bool,
}
