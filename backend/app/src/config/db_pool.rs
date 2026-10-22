//! The database pools of one process (decisions #28: "a connection pool sized
//! against Postgres"). Every value is a settings-registry key (`db.pool.*`,
//! read-only mirrors of process configuration); a deployment may override one
//! by its environment variable, inside the key's bounds. The API's runtime pool
//! is its share of Postgres `max_connections` once the reserve and the workers
//! are taken out, capped by `db.pool.api_connections`; a plan that cannot fit
//! refuses to start (fail closed) rather than overrun Postgres mid-rollout.

use std::time::Duration;

use console_settings_domain::{SettingKey, SettingKind, SettingValue};

use crate::config::role::AppRole;
use crate::error::AppError;

/// Connections an API process opens besides its runtime pool: the leave,
/// ontology and platform-force command pools, two each (`connect_command_pool`).
pub(crate) const API_COMMAND_CONNECTIONS: u32 = 3 * COMMAND_POOL_CONNECTIONS;
/// Connections of one least-privilege command pool.
pub(crate) const COMMAND_POOL_CONNECTIONS: u32 = 2;
/// The smallest runtime pool a process may run with.
const MIN_RUNTIME_CONNECTIONS: u32 = 2;

const VARS: [(SettingKey, &str); 7] = [
    (
        SettingKey::ActionInboxSourceConcurrency,
        "CONSOLE_ACTION_INBOX_SOURCE_CONCURRENCY",
    ),
    (
        SettingKey::DbPoolApiConnections,
        "CONSOLE_DB_POOL_API_CONNECTIONS",
    ),
    (
        SettingKey::DbPoolWorkerConnections,
        "CONSOLE_DB_POOL_WORKER_CONNECTIONS",
    ),
    (
        SettingKey::DbPoolAcquireTimeoutMs,
        "CONSOLE_DB_POOL_ACQUIRE_TIMEOUT_MS",
    ),
    (
        SettingKey::DbPoolPeakApiProcesses,
        "CONSOLE_DB_POOL_PEAK_API_PROCESSES",
    ),
    (
        SettingKey::DbPoolPeakWorkerProcesses,
        "CONSOLE_DB_POOL_PEAK_WORKER_PROCESSES",
    ),
    (
        SettingKey::DbPoolReservedConnections,
        "CONSOLE_DB_POOL_RESERVED_CONNECTIONS",
    ),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DbPoolConfig {
    pub api_connections: u32,
    pub inbox_source_concurrency: u32,
    pub worker_connections: u32,
    pub acquire_timeout: Duration,
    pub peak_api_processes: u32,
    pub peak_worker_processes: u32,
    pub reserved_connections: u32,
}

/// One key's value: its environment override, else the registry default.
fn value(key: SettingKey, env: &str, raw: Option<&String>) -> Result<u32, AppError> {
    let def = key.def();
    let (SettingKind::Int { min, max, .. }, Some(SettingValue::Int(default))) =
        (def.kind, def.default)
    else {
        return Err(AppError::Config(format!(
            "{} is not an integer setting",
            key.as_str()
        )));
    };
    let value = match raw.map(|raw| raw.trim()).filter(|raw| !raw.is_empty()) {
        None => default,
        Some(raw) => raw
            .parse::<i64>()
            .map_err(|err| AppError::Config(format!("invalid {env}: {err}")))?,
    };
    if min.is_some_and(|min| value < min) || max.is_some_and(|max| value > max) {
        return Err(AppError::Config(format!(
            "{env}={value} is outside {} bounds {min:?}..={max:?}",
            key.as_str()
        )));
    }
    if value != default {
        tracing::info!(
            key = key.as_str(),
            value,
            default,
            "database pool setting overridden by the environment"
        );
    }
    u32::try_from(value).map_err(|err| AppError::Config(format!("invalid {env}: {err}")))
}

impl DbPoolConfig {
    /// The registry values, with any `CONSOLE_DB_POOL_*` override.
    pub(crate) fn from_vars(get: impl Fn(&str) -> Option<String>) -> Result<Self, AppError> {
        let mut values = [0_u32; 7];
        for (slot, (key, env)) in values.iter_mut().zip(VARS) {
            *slot = value(key, env, get(env).as_ref())?;
        }
        let [
            inbox_source_concurrency,
            api,
            worker,
            acquire_ms,
            peak_api,
            peak_worker,
            reserved,
        ] = values;
        Ok(Self {
            api_connections: api,
            inbox_source_concurrency,
            worker_connections: worker,
            acquire_timeout: Duration::from_millis(u64::from(acquire_ms)),
            peak_api_processes: peak_api,
            peak_worker_processes: peak_worker,
            reserved_connections: reserved,
        })
    }

    /// The runtime pool of a `role` process against Postgres's
    /// `max_connections`: the reserve and every peak worker come first; each
    /// peak API process gets an equal share of the rest, less its command
    /// pools, capped by `db.pool.api_connections`. Refuses (fail closed) when a
    /// process would get fewer than two connections.
    pub fn runtime_pool_size(&self, role: AppRole, max_connections: u32) -> Result<u32, AppError> {
        let workers = self.peak_worker_processes * self.worker_connections;
        let api_share = max_connections.saturating_sub(self.reserved_connections + workers)
            / self.peak_api_processes;
        let api = api_share
            .saturating_sub(API_COMMAND_CONNECTIONS)
            .min(self.api_connections);
        if api < MIN_RUNTIME_CONNECTIONS {
            return Err(AppError::Config(format!(
                "database pool plan does not fit Postgres max_connections={max_connections}: \
                 reserved {} + {} worker(s) x {} leave {api_share} per API process for {} \
                 API process(es), {API_COMMAND_CONNECTIONS} of them command pools",
                self.reserved_connections,
                self.peak_worker_processes,
                self.worker_connections,
                self.peak_api_processes,
            )));
        }
        Ok(match role {
            AppRole::Api => api,
            AppRole::Worker | AppRole::Migrate | AppRole::SchemaCheck => self.worker_connections,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn config(vars: &[(&str, &str)]) -> Result<DbPoolConfig, AppError> {
        let vars: HashMap<String, String> = vars
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect();
        DbPoolConfig::from_vars(|name| vars.get(name).cloned())
    }

    #[test]
    fn registry_defaults_size_the_a1_box() {
        let config = config(&[]).unwrap();
        assert_eq!(config.acquire_timeout, Duration::from_millis(1_000));
        assert_eq!(config.inbox_source_concurrency, 4);
        // 60 - 8 reserved - 2 workers x 6 = 40; 20 per API process, 6 of them command pools.
        assert_eq!(config.runtime_pool_size(AppRole::Api, 60).unwrap(), 14);
        assert_eq!(config.runtime_pool_size(AppRole::Worker, 60).unwrap(), 6);
        // A bigger Postgres: the cap holds.
        assert_eq!(config.runtime_pool_size(AppRole::Api, 200).unwrap(), 16);
    }

    #[test]
    fn regression_a_plan_that_overruns_postgres_refuses_to_start() {
        // Four API pods (the old blue/green comment) do not fit 60 with two workers.
        let four = config(&[("CONSOLE_DB_POOL_PEAK_API_PROCESSES", "8")]).unwrap();
        let error = four.runtime_pool_size(AppRole::Api, 60).unwrap_err();
        assert!(error.to_string().contains("does not fit"), "{error}");
        // The worker refuses too: it would starve the API it shares Postgres with.
        assert!(four.runtime_pool_size(AppRole::Worker, 60).is_err());
    }

    #[test]
    fn overrides_outside_the_registry_bounds_are_refused() {
        for (name, raw) in [
            ("CONSOLE_DB_POOL_API_CONNECTIONS", "1"),
            ("CONSOLE_DB_POOL_API_CONNECTIONS", "49"),
            ("CONSOLE_DB_POOL_ACQUIRE_TIMEOUT_MS", "50"),
            ("CONSOLE_DB_POOL_RESERVED_CONNECTIONS", "-1"),
            ("CONSOLE_DB_POOL_WORKER_CONNECTIONS", "six"),
            ("CONSOLE_ACTION_INBOX_SOURCE_CONCURRENCY", "0"),
            ("CONSOLE_ACTION_INBOX_SOURCE_CONCURRENCY", "9"),
        ] {
            assert!(config(&[(name, raw)]).is_err(), "{name}={raw}");
        }
        let tuned = config(&[("CONSOLE_DB_POOL_API_CONNECTIONS", "10")]).unwrap();
        assert_eq!(tuned.runtime_pool_size(AppRole::Api, 60).unwrap(), 10);
    }
}
