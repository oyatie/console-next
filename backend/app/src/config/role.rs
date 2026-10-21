//! The process role (`CONSOLE_APP_ROLE`).

use crate::error::AppError;
use serde::Serialize;
use std::fmt::{Display, Formatter};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppRole {
    Api,
    Worker,
    /// One-shot schema-migration mode. Connects to `DATABASE_URL` as the table
    /// OWNER, runs the embedded migrations, then exits â it never serves HTTP.
    /// Invoked out of band (an Argo CD PreSync Job) before the api/worker
    /// Deployments roll, so the runtime `console_rt` role never needs DDL.
    Migrate,
    /// BG-3: PREPARE every compile-time-checked query against `DATABASE_URL`,
    /// then exit (0 compatible, 1 not). The rollback rehearsal runs it with
    /// the previous release on the migrated copy. Never serves HTTP.
    SchemaCheck,
}

impl Display for AppRole {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api => f.write_str("api"),
            Self::Worker => f.write_str("worker"),
            Self::Migrate => f.write_str("migrate"),
            Self::SchemaCheck => f.write_str("schema-check"),
        }
    }
}

impl std::str::FromStr for AppRole {
    type Err = AppError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "api" => Ok(Self::Api),
            "worker" => Ok(Self::Worker),
            "migrate" => Ok(Self::Migrate),
            "schema-check" => Ok(Self::SchemaCheck),
            other => Err(AppError::Config(format!(
                "CONSOLE_APP_ROLE must be api, worker, migrate or schema-check, got {other:?}"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AppRole;

    #[test]
    fn schema_check_is_a_role() {
        let role = "schema-check".parse::<AppRole>().unwrap();
        assert_eq!(role.to_string(), "schema-check");
        assert!("schema_check".parse::<AppRole>().is_err());
    }
}
